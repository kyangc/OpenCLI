const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const FORBIDDEN_OUTPUT_FLAGS = new Set(['-f', '--format']);

export class InputError extends Error {
  constructor(message, { code = 'invalid_request', field = null, retryable = false } = {}) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.field = field;
    this.retryable = retryable;
  }
}

function validateParamValue(argument, value) {
  const type = argument.type;
  if (type === 'bool' || type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new InputError(`${argument.name} must be a boolean`, {
        code: 'invalid_parameter', field: argument.name,
      });
    }
    return value;
  }
  if (type === 'int') {
    if (!Number.isInteger(value)) {
      throw new InputError(`${argument.name} must be an integer`, {
        code: 'invalid_parameter', field: argument.name,
      });
    }
  } else if (type === 'float' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InputError(`${argument.name} must be a finite number`, {
        code: 'invalid_parameter', field: argument.name,
      });
    }
  } else if (typeof value !== 'string' || value.length > 2048 || value.includes('\0')) {
    throw new InputError(`${argument.name} must be a string of at most 2048 characters without NUL bytes`, {
      code: 'invalid_parameter', field: argument.name,
    });
  }
  if (Array.isArray(argument.choices) && argument.choices.length > 0 && !argument.choices.includes(value)) {
    throw new InputError(`${argument.name} must be one of: ${argument.choices.join(', ')}`, {
      code: 'invalid_parameter', field: argument.name,
    });
  }
  return value;
}

function buildArgsFromParams(params, definition, deniedArguments) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new InputError('params must be a JSON object', {
      code: 'invalid_parameter', field: 'params',
    });
  }
  const argumentsByName = new Map(definition.args.map((argument) => [argument.name, argument]));
  for (const name of Object.keys(params)) {
    if (!argumentsByName.has(name)) {
      throw new InputError(`unknown parameter: ${name}`, { code: 'unknown_parameter', field: name });
    }
    if (deniedArguments.has(name)) {
      throw new InputError(`parameter ${name} is not allowed`, {
        code: 'parameter_not_allowed', field: name,
      });
    }
  }

  const positional = [];
  const options = [];
  for (const argument of definition.args) {
    const present = Object.hasOwn(params, argument.name);
    if (!present) {
      if (argument.required) {
        throw new InputError(`missing required parameter: ${argument.name}`, {
          code: 'missing_parameter', field: argument.name,
        });
      }
      continue;
    }
    const value = validateParamValue(argument, params[argument.name]);
    if (argument.positional) {
      positional.push(String(value));
    } else if (argument.type === 'bool' || argument.type === 'boolean') {
      if (value) options.push(`--${argument.name}`);
    } else {
      options.push(`--${argument.name}`, String(value));
    }
  }
  return [...positional, ...options];
}

export function validateJobInput(input, config, catalog = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('request body must be a JSON object', { code: 'invalid_body' });
  }

  const { site, command } = input;
  if (typeof site !== 'string' || !NAME_PATTERN.test(site)) {
    throw new InputError('site must match /^[a-z0-9][a-z0-9-]{0,63}$/', {
      code: 'invalid_parameter', field: 'site',
    });
  }
  if (typeof command !== 'string' || !NAME_PATTERN.test(command)) {
    throw new InputError('command must match /^[a-z0-9][a-z0-9-]{0,63}$/', {
      code: 'invalid_parameter', field: 'command',
    });
  }
  const definition = catalog?.get(site, command) ?? null;
  if (catalog ? !definition : !config.allowedCommands.has(`${site}.${command}`)) {
    throw new InputError(`command ${site}.${command} is not allowed`, {
      code: 'command_not_allowed', field: 'command',
    });
  }
  if (catalog && input.args !== undefined && !config.allowedCommands.has(`${site}.${command}`)) {
    throw new InputError('dynamically discovered commands require structured params', {
      code: 'raw_args_not_allowed', field: 'args',
    });
  }

  if (input.args !== undefined && input.params !== undefined) {
    throw new InputError('provide either args or params, not both', {
      code: 'conflicting_parameters', field: 'params',
    });
  }
  let args;
  if (input.params !== undefined || (catalog && input.args === undefined)) {
    args = buildArgsFromParams(input.params ?? {}, definition, config.deniedArguments ?? new Set());
  } else {
    args = input.args ?? [];
  }
  if (!Array.isArray(args) || args.length > 32) {
    throw new InputError('args must be an array with at most 32 entries', {
      code: 'invalid_parameter', field: 'args',
    });
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0')) {
      throw new InputError('each arg must be a string of at most 2048 characters without NUL bytes', {
        code: 'invalid_parameter', field: 'args',
      });
    }
    if (FORBIDDEN_OUTPUT_FLAGS.has(arg) || arg.startsWith('--format=')) {
      throw new InputError('output format is managed by the service', {
        code: 'parameter_not_allowed', field: 'args',
      });
    }
  }

  const profile = input.profile ?? null;
  if (profile !== null && (typeof profile !== 'string' || !PROFILE_PATTERN.test(profile))) {
    throw new InputError('profile contains unsupported characters', {
      code: 'invalid_parameter', field: 'profile',
    });
  }

  const timeoutSeconds = input.timeoutSeconds ?? config.defaultTimeoutSeconds;
  if (
    !Number.isInteger(timeoutSeconds)
    || timeoutSeconds <= 0
    || timeoutSeconds > config.maxTimeoutSeconds
  ) {
    throw new InputError(`timeoutSeconds must be an integer between 1 and ${config.maxTimeoutSeconds}`, {
      code: 'invalid_parameter', field: 'timeoutSeconds',
    });
  }

  return { site, command, args: [...args], profile, timeoutSeconds };
}

export function buildOpenCliArgv(request) {
  const argv = [];
  if (request.profile) argv.push('--profile', request.profile);
  argv.push(request.site, request.command, ...request.args, '--format', 'json');
  return argv;
}
