import type {JobEvent} from './types.js';

const hiddenCodexKinds = new Set([
  'codex_start',
  'codex_output',
  'error',
]);

export type PublicJobEvent = Omit<JobEvent, 'data'>;

export const isUserFacingEvent = (event: Pick<JobEvent, 'kind' | 'data'>): boolean => {
  if (hiddenCodexKinds.has(event.kind)) return false;
  if (!/^(?:item|thread|turn)\./.test(event.kind)) return true;
  return event.kind === 'item.completed' && event.data.itemType === 'agent_message';
};

export const publicEvents = (events: JobEvent[]): PublicJobEvent[] =>
  events
    .filter(isUserFacingEvent)
    .map(({data: _data, ...event}) => event);
