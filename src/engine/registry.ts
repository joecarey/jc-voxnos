// App registry - manages routing to different voice applications

import type { VoxnosApp } from './types.js';

interface RegistryEntry {
  app: VoxnosApp;
  dynamic: boolean;
}

interface RegisterOpts {
  isDefault?: boolean;
  dynamic?: boolean;
}

class AppRegistry {
  private apps = new Map<string, RegistryEntry>();
  private phoneRoutes = new Map<string, string>(); // phone number → app ID
  private defaultApp?: VoxnosApp;

  // Register a new app
  register(app: VoxnosApp, opts: RegisterOpts = {}): void {
    this.apps.set(app.id, { app, dynamic: opts.dynamic ?? false });
    if (opts.isDefault) {
      this.defaultApp = app;
    }
  }

  // Get app by ID
  get(appId: string): VoxnosApp | undefined {
    return this.apps.get(appId)?.app;
  }

  // Get app for a phone number — checks phone routes first, falls back to default
  getForNumber(phoneNumber: string): VoxnosApp | undefined {
    const appId = this.phoneRoutes.get(phoneNumber);
    if (appId) {
      const app = this.apps.get(appId)?.app;
      if (app) return app;
    }
    return this.defaultApp;
  }

  // Set a phone number → app route
  setPhoneRoute(phoneNumber: string, appId: string): void {
    this.phoneRoutes.set(phoneNumber, appId);
  }

  // Remove a phone route
  removePhoneRoute(phoneNumber: string): boolean {
    return this.phoneRoutes.delete(phoneNumber);
  }

  // Clear all phone routes
  clearPhoneRoutes(): void {
    this.phoneRoutes.clear();
  }

  // Remove a single app by ID
  remove(appId: string): boolean {
    return this.apps.delete(appId);
  }

  // Remove all dynamically registered apps and phone routes (for reload)
  removeDynamic(): void {
    for (const [id, entry] of this.apps) {
      if (entry.dynamic) {
        this.apps.delete(id);
      }
    }
    this.defaultApp = undefined;
    this.phoneRoutes.clear();
  }

  // List all registered apps
  list(): VoxnosApp[] {
    return Array.from(this.apps.values()).map(e => e.app);
  }
}

export const registry = new AppRegistry();
