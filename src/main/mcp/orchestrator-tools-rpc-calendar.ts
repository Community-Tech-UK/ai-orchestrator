import {
  CalendarListAccountsToolArgsSchema,
  CalendarListCalendarsToolArgsSchema,
  CalendarListEventsToolArgsSchema,
  CalendarStatusToolArgsSchema,
} from './orchestrator-calendar-tools';

export const CALENDAR_TOOL_NAMES = [
  'graph_calendar_connect',
  'graph_calendar_status',
  'graph_calendar_list_accounts',
  'graph_calendar_list_calendars',
  'graph_calendar_list_events',
  'graph_calendar_create_event',
  'graph_calendar_update_event',
  'graph_calendar_delete_event',
] as const;

/** Read-only calendar RPC routes for the server's generic validated dispatch. */
export const CALENDAR_READ_RPC_SPECS = [
  {
    method: 'orchestrator_tools.graph_calendar_status',
    toolName: 'graph_calendar_status',
    schema: CalendarStatusToolArgsSchema,
  },
  {
    method: 'orchestrator_tools.graph_calendar_list_accounts',
    toolName: 'graph_calendar_list_accounts',
    schema: CalendarListAccountsToolArgsSchema,
  },
  {
    method: 'orchestrator_tools.graph_calendar_list_calendars',
    toolName: 'graph_calendar_list_calendars',
    schema: CalendarListCalendarsToolArgsSchema,
  },
  {
    method: 'orchestrator_tools.graph_calendar_list_events',
    toolName: 'graph_calendar_list_events',
    schema: CalendarListEventsToolArgsSchema,
  },
] as const;
