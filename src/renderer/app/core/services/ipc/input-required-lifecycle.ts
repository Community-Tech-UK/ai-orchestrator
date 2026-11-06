import { statusClearsOpenRequests } from '../../../../../shared/utils/request-outcome';

/**
 * Runtime transitions that invalidate outstanding CLI input requests. The
 * statuses are shared with main, which words the receipt for a request they close.
 */
export const shouldClearInputRequiredForStatus: (status: string | undefined) => boolean = statusClearsOpenRequests;
