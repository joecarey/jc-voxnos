// Tool registry for managing available tools

import type { Tool, ToolDefinition } from './types.js';

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

  async execute(name: string, input: Record<string, any>): Promise<string> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return await tool.execute(input);
  }
}

export const toolRegistry = new ToolRegistry();
