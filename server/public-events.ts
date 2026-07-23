import type {JobEvent} from './types.js';

const hiddenCodexKinds = new Set([
  'codex_start',
  'codex_output',
  'error',
]);

export type PublicJobEvent = Omit<JobEvent, 'data'>;

export const publicEvents = (events: JobEvent[]): PublicJobEvent[] =>
  events
    .filter((event) => !hiddenCodexKinds.has(event.kind))
    .filter((event) => {
      if (!/^(?:item|thread|turn)\./.test(event.kind)) return true;
      return event.kind === 'item.completed' && event.data.itemType === 'agent_message';
    })
    .map(({data: _data, ...event}) => event);
