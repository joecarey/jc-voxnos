// Tool system for extending assistant capabilities

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolUseRequest {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface Tool {
  // Tool metadata for Claude API
  definition: ToolDefinition;

  // Execute the tool with given input
  execute(input: Record<string, any>): Promise<string>;
}
