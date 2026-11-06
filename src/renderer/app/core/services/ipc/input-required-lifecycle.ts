/** Runtime transitions that invalidate outstanding CLI input requests. */
export function shouldClearInputRequiredForStatus(status: string | undefined): boolean {
  return status === 'terminated'
    || status === 'failed'
    || status === 'error'
    || status === 'cancelled'
    || status === 'hibernated'
    || status === 'initializing'
    || status === 'respawning'
    || status === 'interrupting'
    || status === 'cancelling'
    || status === 'interrupt-escalating'
    || status === 'waking';
}
