// App registry - manages routing to different voice applications

import type { VoxnosApp } from './types.js';

class AppRegistry {
  private apps = new Map<string, VoxnosApp>();
  private defaultApp?: VoxnosApp;

  // Register a new app
  register(app: VoxnosApp, isDefault = false): void {
    this.apps.set(app.id, app);
    if (isDefault) {
      this.defaultApp = app;
    }
  }

  // Get app by ID
  get(appId: string): VoxnosApp | undefined {
    return this.apps.get(appId);
  }

  // Get app for a phone number
  // For now, returns default app
  // TODO: Add phone number → app mapping in database
  getForNumber(phoneNumber: string): VoxnosApp | undefined {
    // Future: query database for phone number → app mapping
    // For now, just return default
    return this.defaultApp;
  }

  // List all registered apps
  list(): VoxnosApp[] {
    return Array.from(this.apps.values());
  }
}

export const registry = new AppRegistry();
