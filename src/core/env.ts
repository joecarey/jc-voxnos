// Environment variable validation

import type { Env } from './types.js';

/**
 * Required environment variables
 */
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FREECLIMB_ACCOUNT_ID',
  'FREECLIMB_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * Validation result for environment variables
 */
export interface EnvValidationResult {
  valid: boolean;
  missing: string[];
  errors: string[];
}

/**
 * Validate that all required environment variables are present
 *
 * @param env - Environment object to validate
 * @returns Validation result with missing variables and errors
 */
export function validateEnv(env: Partial<Env>): EnvValidationResult {
  const missing: string[] = [];
  const errors: string[] = [];

  // Check for missing variables
  for (const varName of REQUIRED_ENV_VARS) {
    if (!env[varName]) {
      missing.push(varName);
    }
  }

  // Check for empty strings
  for (const varName of REQUIRED_ENV_VARS) {
    const value = env[varName];
    if (value !== undefined && value.trim() === '') {
      errors.push(`${varName} is empty (must be a non-empty string)`);
    }
  }

  // Additional validation for specific variables
  if (env.SUPABASE_URL && !isValidUrl(env.SUPABASE_URL)) {
    errors.push('SUPABASE_URL must be a valid URL');
  }

  return {
    valid: missing.length === 0 && errors.length === 0,
    missing,
    errors,
  };
}

/**
 * Validate environment variables and throw error if invalid
 * Use this in the fetch handler to ensure environment is configured correctly
 *
 * @param env - Environment object to validate
 * @throws Error if validation fails
 */
export function assertValidEnv(env: Partial<Env>): asserts env is Env {
  const result = validateEnv(env);

  if (!result.valid) {
    const errorMessage = [
      'Environment validation failed:',
      ...result.missing.map(v => `  - Missing: ${v}`),
      ...result.errors.map(e => `  - Error: ${e}`),
    ].join('\n');

    throw new Error(errorMessage);
  }
}

/**
 * Simple URL validation helper
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Get a human-readable error message for missing environment variables
 */
export function getEnvSetupInstructions(result: EnvValidationResult): string {
  if (result.valid) {
    return 'Environment is properly configured.';
  }

  const lines = [
    '=== Voxnos Environment Configuration ===',
    '',
    'Missing or invalid environment variables detected.',
    '',
  ];

  if (result.missing.length > 0) {
    lines.push('Missing variables:');
    for (const varName of result.missing) {
      lines.push(`  ${varName}`);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('Validation errors:');
    for (const error of result.errors) {
      lines.push(`  ${error}`);
    }
    lines.push('');
  }

  lines.push('To configure these variables:');
  lines.push('  1. Create a .dev.vars file in your project root');
  lines.push('  2. Add the following variables:');
  lines.push('');
  for (const varName of REQUIRED_ENV_VARS) {
    lines.push(`     ${varName}=your_value_here`);
  }
  lines.push('');
  lines.push('  3. For production, set these as Cloudflare Workers secrets:');
  lines.push('     wrangler secret put <VARIABLE_NAME>');
  lines.push('');

  return lines.join('\n');
}
