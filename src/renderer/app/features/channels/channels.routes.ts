import { Routes } from '@angular/router';

export const CHANNELS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./components/channel-connections/channel-connections.component')
        .then(m => m.ChannelConnectionsComponent),
  },
  {
    path: 'messages',
    loadComponent: () =>
      import('./components/channel-messages/channel-messages.component')
        .then(m => m.ChannelMessagesComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./components/channel-settings/channel-settings.component')
        .then(m => m.ChannelSettingsComponent),
  },
];
