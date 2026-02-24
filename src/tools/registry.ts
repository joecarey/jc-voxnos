// Tool registry for managing available tools

import type { Tool, ToolDefinition, ToolContext } from './types.js';
import { validateToolInput } from './validation.js';

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
    console.log(`Registered tool: ${tool.definition.name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.definition);
  }

  /** Return definitions for only the named tools. Unknown names are skipped with a warning. */
  getDefinitionsFor(names: string[]): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) {
        defs.push(tool.definition);
      } else {
        console.warn(`ToolRegistry: unknown tool name "${name}"`);
      }
    }
    return defs;
  }

  async execute(name: string, input: Record<string, any>, context?: ToolContext): Promise<string> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    // VALIDATION: Validate input against schema
    const validation = validateToolInput(name, input, tool.definition.input_schema);
    if (!validation.valid) {
      console.error(`Tool validation failed: ${name}`, validation.error);
      return `Error: Invalid input for ${name}. ${validation.error}`;
    }

    // TIMEOUT: 10 seconds max execution time
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('Tool execution timeout')), 10000);
    });

    try {
      const result = await Promise.race([
        tool.execute(validation.sanitizedInput!, context),
        timeoutPromise
      ]);
      return result;
    } catch (error: any) {
      console.error(`Tool execution error: ${name}`, error);
      return `Error executing ${name}: ${error.message}`;
    }
  }
}

export const toolRegistry = new ToolRegistry();
