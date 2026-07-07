export interface AppState {
  global: {
    memoryPressure: 'normal' | 'warning' | 'critical';
  };
}

export const INITIAL_APP_STATE: AppState = {
  global: {
    memoryPressure: 'normal',
  },
};
