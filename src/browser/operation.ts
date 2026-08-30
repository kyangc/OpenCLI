import { sendCommand } from './daemon-client.js';

export type BrowserTeardownReceipt = {
  operationId: string;
  contextId: string;
  surface: 'browser' | 'adapter';
  reason: string;
  status: 'verified' | 'incomplete';
  startedAt: number;
  completedAt: number;
  lateCommandsBlocked: boolean;
  leaseReleased: boolean;
  targetPages: string[];
  survivingPages: string[];
};

export type BrowserInventory = {
  capturedAt: number;
  contextId: string;
  windows: BrowserInventoryWindow[];
  tabs: BrowserInventoryTab[];
  leases: BrowserInventoryLease[];
};

export type BrowserInventoryLease = {
  operationId: string;
  surface: 'browser' | 'adapter';
  lifecycle: 'ephemeral' | 'persistent' | 'pinned';
  ownership: 'owned' | 'borrowed';
  windowRole: 'interactive' | 'automation' | 'borrowed-user';
  page?: string;
};

export type BrowserInventoryWindow = {
  id: number;
  focused: boolean;
  type?: string;
  state?: string;
  role: 'interactive' | 'automation' | 'user';
};

export type BrowserInventoryTab = {
  page?: string;
  windowId: number;
  active: boolean;
  url?: string;
  lease?: BrowserInventoryLease;
};

export type BrowserOperationRoute = {
  operationId: string;
  contextId?: string;
  preferredContextId?: string;
  surface: 'browser' | 'adapter';
  siteSession: 'ephemeral' | 'persistent';
  windowMode?: 'foreground' | 'background';
};

export interface BrowserOperationTransport {
  send(action: 'operation-cancel' | 'inventory', params: Record<string, unknown>): Promise<unknown>;
}

const daemonTransport: BrowserOperationTransport = {
  send: (action, params) => sendCommand(action, params),
};

export class BrowserOperationTeardownError extends Error {
  readonly operationError?: unknown;

  constructor(
    message: string,
    readonly receipt?: BrowserTeardownReceipt,
    options?: { cause?: unknown; operationError?: unknown },
  ) {
    super(message, options);
    this.name = 'BrowserOperationTeardownError';
    this.operationError = options?.operationError;
  }
}

function requireReceipt(value: unknown, route: BrowserOperationRoute): BrowserTeardownReceipt {
  const receipt = value as Partial<BrowserTeardownReceipt> | null;
  if (!receipt
    || typeof receipt.operationId !== 'string'
    || typeof receipt.contextId !== 'string'
    || (receipt.surface !== 'browser' && receipt.surface !== 'adapter')
    || (receipt.status !== 'verified' && receipt.status !== 'incomplete')
    || typeof receipt.reason !== 'string'
    || typeof receipt.startedAt !== 'number'
    || typeof receipt.completedAt !== 'number'
    || typeof receipt.lateCommandsBlocked !== 'boolean'
    || typeof receipt.leaseReleased !== 'boolean'
    || !Array.isArray(receipt.targetPages)
    || !receipt.targetPages.every((page) => typeof page === 'string')
    || !Array.isArray(receipt.survivingPages)
    || !receipt.survivingPages.every((page) => typeof page === 'string')
    || receipt.operationId !== route.operationId
    || receipt.surface !== route.surface
    || (receipt.status === 'verified'
      && (!receipt.lateCommandsBlocked || !receipt.leaseReleased || receipt.survivingPages.length > 0))) {
    throw new BrowserOperationTeardownError('Browser operation returned an invalid teardown receipt.');
  }
  return receipt as BrowserTeardownReceipt;
}

function receiptFromError(error: unknown, route: BrowserOperationRoute): BrowserTeardownReceipt | undefined {
  if (!error || typeof error !== 'object' || !('teardown' in error)) return undefined;
  const teardown = (error as { teardown?: unknown }).teardown;
  return teardown === undefined ? undefined : requireReceipt(teardown, route);
}

function isInventoryLease(value: unknown): value is BrowserInventoryLease {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Partial<BrowserInventoryLease>;
  return typeof lease.operationId === 'string'
    && (lease.surface === 'browser' || lease.surface === 'adapter')
    && (lease.lifecycle === 'ephemeral' || lease.lifecycle === 'persistent' || lease.lifecycle === 'pinned')
    && (lease.ownership === 'owned' || lease.ownership === 'borrowed')
    && (lease.windowRole === 'interactive' || lease.windowRole === 'automation' || lease.windowRole === 'borrowed-user')
    && (lease.page === undefined || typeof lease.page === 'string');
}

function requireInventory(value: unknown): BrowserInventory {
  const inventory = value as Partial<BrowserInventory> | null;
  if (!inventory
    || typeof inventory.capturedAt !== 'number'
    || typeof inventory.contextId !== 'string'
    || !Array.isArray(inventory.windows)
    || !inventory.windows.every((value) => {
      if (!value || typeof value !== 'object') return false;
      const window = value as Partial<BrowserInventoryWindow>;
      return typeof window.id === 'number'
        && typeof window.focused === 'boolean'
        && (window.role === 'interactive' || window.role === 'automation' || window.role === 'user');
    })
    || !Array.isArray(inventory.tabs)
    || !inventory.tabs.every((value) => {
      if (!value || typeof value !== 'object') return false;
      const tab = value as Partial<BrowserInventoryTab>;
      return typeof tab.windowId === 'number'
        && typeof tab.active === 'boolean'
        && (tab.page === undefined || typeof tab.page === 'string')
        && (tab.url === undefined || typeof tab.url === 'string')
        && (tab.lease === undefined || isInventoryLease(tab.lease));
    })
    || !Array.isArray(inventory.leases)
    || !inventory.leases.every(isInventoryLease)) {
    throw new Error('Browser operation returned an invalid inventory.');
  }
  return inventory as BrowserInventory;
}

export class BrowserOperation {
  constructor(
    private readonly route: BrowserOperationRoute,
    private readonly transport: BrowserOperationTransport = daemonTransport,
  ) {}

  async execute<T>(
    run: () => Promise<T>,
    opts: { retain?: boolean } = {},
  ): Promise<{ result: T; teardown: BrowserTeardownReceipt | null }> {
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await run();
    } catch (err) {
      operationError = err;
    }

    if (opts.retain || this.route.siteSession === 'persistent') {
      if (operationError !== undefined) throw operationError;
      return { result: result as T, teardown: null };
    }

    let teardown: BrowserTeardownReceipt;
    try {
      teardown = receiptFromError(operationError, this.route) ?? await this.cancel();
    } catch (err) {
      throw new BrowserOperationTeardownError(
        `Browser operation "${this.route.operationId}" ended without a verified teardown receipt.`,
        undefined,
        { cause: err, operationError },
      );
    }
    if (teardown.status !== 'verified') {
      throw new BrowserOperationTeardownError(
        `Browser operation "${this.route.operationId}" teardown is incomplete.`,
        teardown,
        { cause: operationError, operationError },
      );
    }
    if (operationError !== undefined) {
      if (operationError instanceof Error) {
        (operationError as Error & { teardown?: BrowserTeardownReceipt }).teardown = teardown;
      }
      throw operationError;
    }
    return { result: result as T, teardown };
  }

  async cancel(): Promise<BrowserTeardownReceipt> {
    try {
      const raw = await this.transport.send('operation-cancel', {
        session: this.route.operationId,
        surface: this.route.surface,
        siteSession: this.route.siteSession,
        ...(this.route.contextId ? { contextId: this.route.contextId } : {}),
        ...(this.route.preferredContextId ? { preferredContextId: this.route.preferredContextId } : {}),
        ...(this.route.windowMode ? { windowMode: this.route.windowMode } : {}),
      });
      return requireReceipt(raw, this.route);
    } catch (err) {
      const receipt = receiptFromError(err, this.route);
      if (receipt) return receipt;
      throw err;
    }
  }

  async inventory(): Promise<BrowserInventory> {
    const raw = await this.transport.send('inventory', {
      ...(this.route.contextId ? { contextId: this.route.contextId } : {}),
      ...(this.route.preferredContextId ? { preferredContextId: this.route.preferredContextId } : {}),
    });
    return requireInventory(raw);
  }
}
