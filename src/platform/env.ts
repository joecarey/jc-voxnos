// Environment variable validation

import type { Env } from '../engine/types.js';

/**
 * Required environment variables
 */
const REQUIRED_ENV_VARS = [
  'FREECLIMB_ACCOUNT_ID',
  'FREECLIMB_API_KEY',
  'FREECLIMB_SIGNING_SECRET',
  'ANTHROPIC_API_KEY',
  'ADMIN_API_KEY',
  'TTS_SIGNING_SECRET',
  'COGNOS_PUBLIC_KEY',
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

  // Mode-conditional TTS key requirements
  const ttsMode = env.TTS_MODE ?? 'freeclimb';
  if (ttsMode === 'google' && !env.GOOGLE_TTS_API_KEY) {
    errors.push('GOOGLE_TTS_API_KEY is required when TTS_MODE=google');
  }
  if (ttsMode === '11labs' && !env.ELEVENLABS_API_KEY) {
    errors.push('ELEVENLABS_API_KEY is required when TTS_MODE=11labs');
  }

  return {
    valid: missing.length === 0 && errors.length === 0,
    missing,
    errors,
  };
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
