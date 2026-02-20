// Tool input validation against JSON schemas

export interface SchemaValidationResult {
  valid: boolean;
  error?: string;
  sanitizedInput?: Record<string, any>;
}

/**
 * Validate tool input against JSON schema
 *
 * @param toolName - Name of the tool (for error messages)
 * @param input - Input object from Claude API
 * @param schema - JSON schema from tool definition
 * @returns Validation result with sanitized input if valid
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, any>,
  schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  }
): SchemaValidationResult {
  // Check that input is an object
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      valid: false,
      error: 'Input must be an object',
    };
  }

  const sanitized: Record<string, any> = {};

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in input)) {
        return {
          valid: false,
          error: `Missing required field: ${field}`,
        };
      }
    }
  }

  // Validate each property in the input
  for (const [key, value] of Object.entries(input)) {
    const propSchema = schema.properties[key];

    // Allow unexpected properties (lenient validation)
    if (!propSchema) {
      sanitized[key] = value;
      continue;
    }

    // Validate the property
    const result = validateProperty(value, propSchema, key);
    if (!result.valid) {
      return {
        valid: false,
        error: result.error,
      };
    }

    sanitized[key] = result.value;
  }

  return {
    valid: true,
    sanitizedInput: sanitized,
  };
}

/**
 * Validate a single property against its schema
 */
function validateProperty(
  value: any,
  propertySchema: any,
  propertyName: string
): { valid: boolean; error?: string; value?: any } {
  const type = propertySchema.type;

  // Handle null values
  if (value === null) {
    if (type === 'null' || (Array.isArray(type) && type.includes('null'))) {
      return { valid: true, value: null };
    }
    return {
      valid: false,
      error: `Property '${propertyName}' cannot be null`,
    };
  }

  // Handle undefined (optional properties)
  if (value === undefined) {
    return { valid: true, value: undefined };
  }

  // Validate by type
  switch (type) {
    case 'string':
      return validateStringProperty(value, propertyName, propertySchema);

    case 'number':
    case 'integer':
      return validateNumberProperty(value, propertyName, type === 'integer', propertySchema);

    case 'boolean':
      return validateBooleanProperty(value, propertyName);

    case 'object':
      return validateObjectProperty(value, propertyName, propertySchema);

    case 'array':
      return validateArrayProperty(value, propertyName, propertySchema);

    default:
      // Unknown type - allow it through
      return { valid: true, value };
  }
}

/**
 * Validate string property
 */
function validateStringProperty(
  value: any,
  propertyName: string,
  schema: any
): { valid: boolean; error?: string; value?: any } {
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `Property '${propertyName}' must be a string`,
    };
  }

  // Sanitize: trim whitespace
  const sanitized = value.trim();

  // Check length constraints (max 1000 chars for safety)
  const maxLength = schema.maxLength || 1000;
  if (sanitized.length > maxLength) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be at most ${maxLength} characters`,
    };
  }

  const minLength = schema.minLength || 0;
  if (sanitized.length < minLength) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be at least ${minLength} characters`,
    };
  }

  return { valid: true, value: sanitized };
}

/**
 * Validate number property
 */
function validateNumberProperty(
  value: any,
  propertyName: string,
  requireInteger: boolean,
  schema: any
): { valid: boolean; error?: string; value?: any } {
  // Type coercion: accept numeric strings
  let num: number;
  if (typeof value === 'string') {
    num = parseFloat(value);
    if (isNaN(num)) {
      return {
        valid: false,
        error: `Property '${propertyName}' must be a number`,
      };
    }
  } else if (typeof value === 'number') {
    num = value;
  } else {
    return {
      valid: false,
      error: `Property '${propertyName}' must be a number`,
    };
  }

  // Check if integer is required
  if (requireInteger && !Number.isInteger(num)) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be an integer`,
    };
  }

  // Check range constraints
  if (schema.minimum !== undefined && num < schema.minimum) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be at least ${schema.minimum}`,
    };
  }

  if (schema.maximum !== undefined && num > schema.maximum) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be at most ${schema.maximum}`,
    };
  }

  return { valid: true, value: num };
}

/**
 * Validate boolean property
 */
function validateBooleanProperty(
  value: any,
  propertyName: string
): { valid: boolean; error?: string; value?: any } {
  if (typeof value !== 'boolean') {
    return {
      valid: false,
      error: `Property '${propertyName}' must be a boolean`,
    };
  }

  return { valid: true, value };
}

/**
 * Validate object property (simplified - no recursive validation)
 */
function validateObjectProperty(
  value: any,
  propertyName: string,
  schema: any
): { valid: boolean; error?: string; value?: any } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be an object`,
    };
  }

  // For now, accept any object - could add recursive validation later
  return { valid: true, value };
}

/**
 * Validate array property
 */
function validateArrayProperty(
  value: any,
  propertyName: string,
  schema: any
): { valid: boolean; error?: string; value?: any } {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      error: `Property '${propertyName}' must be an array`,
    };
  }

  // Check array length constraints
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    return {
      valid: false,
      error: `Property '${propertyName}' must have at least ${schema.minItems} items`,
    };
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    return {
      valid: false,
      error: `Property '${propertyName}' must have at most ${schema.maxItems} items`,
    };
  }

  // For now, accept the array as-is - could add item validation later
  return { valid: true, value };
}
