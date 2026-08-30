import { describe, expect, it, vi } from 'vitest';
import { BrowserCommandError } from './daemon-client.js';
import {
  BrowserOperation,
  BrowserOperationTeardownError,
  type BrowserTeardownReceipt,
} from './operation.js';

function verifiedReceipt(): BrowserTeardownReceipt {
  return {
    operationId: 'operation-1',
    contextId: 'profile-1',
    surface: 'adapter',
    reason: 'explicit cancellation',
    status: 'verified',
    startedAt: 1,
    completedAt: 2,
    lateCommandsBlocked: true,
    leaseReleased: true,
    targetPages: ['target-1'],
    survivingPages: [],
  };
}

describe('BrowserOperation', () => {
  it('returns the result and verified teardown receipt for an ephemeral operation', async () => {
    const receipt = verifiedReceipt();
    const send = vi.fn(async (action: string) => {
      if (action === 'operation-cancel') return receipt;
      throw new Error(`Unexpected action: ${action}`);
    });
    const operation = new BrowserOperation({
      operationId: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send });

    const outcome = await operation.execute(async () => ({ rows: 2 }));

    expect(outcome).toEqual({ result: { rows: 2 }, teardown: receipt });
    expect(send).toHaveBeenCalledWith('operation-cancel', expect.objectContaining({
      session: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }));
  });

  it('accepts the executor verified receipt without sending a second cancellation', async () => {
    const receipt = verifiedReceipt();
    const operationError = Object.assign(
      new BrowserCommandError('Runtime.evaluate timed out', 'cdp_timeout'),
      { teardown: receipt },
    );
    const send = vi.fn(async () => {
      throw new Error('A second cancellation must not be dispatched');
    });
    const operation = new BrowserOperation({
      operationId: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send });

    const thrown = await operation.execute(async () => {
      throw operationError;
    }).catch((err) => err);

    expect(thrown).toBe(operationError);
    expect(thrown.teardown).toEqual(receipt);
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels after an operation failure and preserves the original error with its receipt', async () => {
    const receipt = verifiedReceipt();
    const operationError = new Error('adapter failed');
    const send = vi.fn(async () => receipt);
    const operation = new BrowserOperation({
      operationId: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send });

    const thrown = await operation.execute(async () => {
      throw operationError;
    }).catch((err) => err);

    expect(thrown).toBe(operationError);
    expect(thrown.teardown).toEqual(receipt);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails loud with the incomplete receipt when physical teardown cannot be verified', async () => {
    const receipt: BrowserTeardownReceipt = {
      ...verifiedReceipt(),
      status: 'incomplete',
      leaseReleased: false,
      survivingPages: ['target-1'],
    };
    const operation = new BrowserOperation({
      operationId: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send: vi.fn(async () => receipt) });

    await expect(operation.execute(async () => 'done')).rejects.toMatchObject({
      name: 'BrowserOperationTeardownError',
      receipt,
    } satisfies Partial<BrowserOperationTeardownError>);
  });

  it('preserves both the operation failure and the cancellation transport failure', async () => {
    const operationError = new Error('adapter failed');
    const cancellationError = new Error('daemon unavailable during cancellation');
    const operation = new BrowserOperation({
      operationId: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send: vi.fn(async () => { throw cancellationError; }) });

    const thrown = await operation.execute(async () => {
      throw operationError;
    }).catch((err) => err);

    expect(thrown).toMatchObject({
      name: 'BrowserOperationTeardownError',
      cause: cancellationError,
      operationError,
    });
  });

  it('returns a complete sanitized browser inventory through the same module', async () => {
    const inventory = {
      capturedAt: 10,
      contextId: 'profile-1',
      windows: [{ id: 1, focused: false, role: 'automation' }],
      tabs: [{ page: 'target-1', windowId: 1, active: true }],
      leases: [{
        operationId: 'operation-1',
        surface: 'adapter',
        lifecycle: 'ephemeral',
        ownership: 'owned',
        windowRole: 'automation',
        page: 'target-1',
      }],
    };
    const send = vi.fn(async () => inventory);
    const operation = new BrowserOperation({
      operationId: 'operation-1',
      contextId: 'profile-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    }, { send });

    await expect(operation.inventory()).resolves.toEqual(inventory);
    expect(send).toHaveBeenCalledWith('inventory', { contextId: 'profile-1' });
  });
});
