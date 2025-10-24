// Simple localStorage-based persistence utility
export class LocalStorageManager {
  private static PREFIX = 'pb-mcpgateway-';

  static get<T>(key: string, defaultValue: T): T {
    try {
      const item = localStorage.getItem(this.PREFIX + key);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  static set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(this.PREFIX + key, JSON.stringify(value));
    } catch (error) {
      console.warn('Failed to save to localStorage:', error);
    }
  }

  static remove(key: string): void {
    try {
      localStorage.removeItem(this.PREFIX + key);
    } catch (error) {
      console.warn('Failed to remove from localStorage:', error);
    }
  }

  static clear(): void {
    try {
      const keys = Object.keys(localStorage).filter(key => 
        key.startsWith(this.PREFIX)
      );
      keys.forEach(key => localStorage.removeItem(key));
    } catch (error) {
      console.warn('Failed to clear localStorage:', error);
    }
  }
}

// User preferences interface
export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  sidebarCollapsed: boolean;
  autoRefreshInterval: number;
  defaultPageSize: number;
  notificationSettings: {
    showSuccessToasts: boolean;
    showErrorToasts: boolean;
    toastDuration: number;
  };
}

// Default preferences
export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'auto',
  sidebarCollapsed: false,
  autoRefreshInterval: 15000,
  defaultPageSize: 10,
  notificationSettings: {
    showSuccessToasts: true,
    showErrorToasts: true,
    toastDuration: 5000
  }
};

// Preferences manager
export class PreferencesManager {
  private static PREFERENCES_KEY = 'user-preferences';

  static getPreferences(): UserPreferences {
    return LocalStorageManager.get(this.PREFERENCES_KEY, DEFAULT_PREFERENCES);
  }

  static setPreferences(preferences: Partial<UserPreferences>): void {
    const current = this.getPreferences();
    const updated = { ...current, ...preferences };
    LocalStorageManager.set(this.PREFERENCES_KEY, updated);
  }

  static resetPreferences(): void {
    LocalStorageManager.remove(this.PREFERENCES_KEY);
  }
}

// UI state persistence
export interface UIState {
  selectedServiceFilters: string[];
  selectedTemplateFilters: string[];
  dashboardLayout: 'grid' | 'list';
  tablePageSizes: Record<string, number>;
}

export const DEFAULT_UI_STATE: UIState = {
  selectedServiceFilters: [],
  selectedTemplateFilters: [],
  dashboardLayout: 'grid',
  tablePageSizes: {}
};

export class UIStateManager {
  private static UI_STATE_KEY = 'ui-state';

  static getUIState(): UIState {
    return LocalStorageManager.get(this.UI_STATE_KEY, DEFAULT_UI_STATE);
  }

  static setUIState(state: Partial<UIState>): void {
    const current = this.getUIState();
    const updated = { ...current, ...state };
    LocalStorageManager.set(this.UI_STATE_KEY, updated);
  }

  static resetUIState(): void {
    LocalStorageManager.remove(this.UI_STATE_KEY);
  }
}