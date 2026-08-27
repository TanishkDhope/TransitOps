import { useMemo } from 'react';
import { useToastContext } from '@/components/ui/toast.jsx';

/**
 * Maps the API's machine-readable error codes to a toast title.
 * The server's own `message` is always used as the description, so the user sees
 * the specific reason ("Vehicle MH-12-AB-1234 is already booked: ...") under a
 * consistent, scannable heading.
 */
const CODE_TITLES = {
  VALIDATION_FAILED: 'Check the form',
  UNAUTHENTICATED: 'Please sign in',
  TOKEN_EXPIRED: 'Session expired',
  INVALID_CREDENTIALS: 'Incorrect email or password',
  FORBIDDEN: "You don't have access",
  NOT_FOUND: 'Not found',
  DUPLICATE: 'Already exists',
  ILLEGAL_TRANSITION: "That action isn't allowed right now",
  RESOURCE_BUSY: 'Currently in use',
  SCHEDULE_CONFLICT: 'Scheduling conflict',
  CAPACITY_EXCEEDED: 'Over capacity',
  LICENSE_EXPIRED: 'Licence problem',
  INTEGRATION_DISABLED: 'Feature unavailable',
  INTEGRATION_FAILED: 'External service failed',
  IN_USE: 'Still referenced',
  PAYLOAD_TOO_LARGE: 'File too large',
  RATE_LIMITED: 'Too many attempts',
  INTERNAL: 'Something went wrong',
};

/** Codes that are the user's situation rather than an error to alarm them about. */
const WARNING_CODES = new Set([
  'ILLEGAL_TRANSITION',
  'RESOURCE_BUSY',
  'SCHEDULE_CONFLICT',
  'CAPACITY_EXCEEDED',
  'LICENSE_EXPIRED',
  'DUPLICATE',
  'IN_USE',
  'VALIDATION_FAILED',
  'INTEGRATION_DISABLED',
  'RATE_LIMITED',
]);

/** Turns any thrown value into { title, description, variant, fields }. */
export function describeError(error, fallbackTitle = 'Something went wrong') {
  // Axios network failure — no response at all.
  if (error?.code === 'ERR_NETWORK' || error?.message === 'Network Error') {
    return {
      title: 'Cannot reach the server',
      description: 'Check your connection and make sure the TransitOps API is running.',
      variant: 'error',
      dedupeKey: 'network',
    };
  }

  if (error?.code === 'ECONNABORTED') {
    return {
      title: 'Request timed out',
      description: 'The server took too long to respond. Please try again.',
      variant: 'error',
    };
  }

  const response = error?.response;
  const payload = response?.data;
  const code = payload?.code;
  const serverMessage = payload?.message;

  if (code && CODE_TITLES[code]) {
    return {
      title: CODE_TITLES[code],
      description: serverMessage,
      variant: WARNING_CODES.has(code) ? 'warning' : 'error',
      fields: payload?.details?.fields,
      dedupeKey: code === 'UNAUTHENTICATED' || code === 'TOKEN_EXPIRED' ? 'auth' : undefined,
    };
  }

  // No structured code — fall back to HTTP status.
  const status = response?.status;
  if (status === 401) {
    return { title: 'Please sign in', description: serverMessage, variant: 'error', dedupeKey: 'auth' };
  }
  if (status === 403) {
    return { title: "You don't have access", description: serverMessage, variant: 'warning' };
  }
  if (status === 404) {
    return { title: 'Not found', description: serverMessage, variant: 'warning' };
  }
  if (status >= 500) {
    return {
      title: 'Server error',
      description: serverMessage || 'Please try again in a moment.',
      variant: 'error',
    };
  }

  return {
    title: serverMessage ? fallbackTitle : (error?.message ?? fallbackTitle),
    description: serverMessage,
    variant: 'error',
  };
}

/**
 * Toast helpers.
 *
 *   const toast = useToast();
 *   toast.success('Vehicle added');
 *   toast.apiError(err);                       // maps code → title, server message → body
 *   toast.fromResponse(data);                  // shows data.message + any data.warnings
 *   await toast.promise(save(), { loading: 'Saving…', success: 'Saved' });
 */
export function useToast() {
  const { push, dismiss, dismissAll, update } = useToastContext();

  return useMemo(
    () => ({
      push,
      dismiss,
      dismissAll,

      success: (title, options = {}) => push({ ...options, title, variant: 'success' }),
      error: (title, options = {}) => push({ ...options, title, variant: 'error' }),
      warning: (title, options = {}) => push({ ...options, title, variant: 'warning' }),
      info: (title, options = {}) => push({ ...options, title, variant: 'info' }),

      /** Renders any caught error with the right title, tone and field hints. */
      apiError: (error, fallbackTitle) => push(describeError(error, fallbackTitle)),

      /**
       * Shows the server's own success message, plus any `warnings[]` it returned
       * (e.g. "Actual distance differs from the plan by +180 km").
       */
      fromResponse: (payload, fallbackTitle = 'Done') => {
        const id = push({
          title: payload?.message || fallbackTitle,
          variant: 'success',
        });

        for (const warning of payload?.warnings ?? []) {
          push({ title: 'Heads up', description: warning, variant: 'warning' });
        }

        return id;
      },

      /** Loading → success/error, resolved in place on a single toast. */
      promise: async (promise, { loading = 'Working…', success, error } = {}) => {
        const id = push({ title: loading, variant: 'loading', dismissible: false });
        try {
          const result = await promise;
          update(id, {
            title:
              typeof success === 'function'
                ? success(result)
                : (success ?? result?.data?.message ?? 'Done'),
            variant: 'success',
            dismissible: true,
          });
          return result;
        } catch (err) {
          const described = describeError(err, typeof error === 'string' ? error : undefined);
          update(id, { ...described, dismissible: true });
          throw err;
        }
      },
    }),
    [push, dismiss, dismissAll, update]
  );
}

export default useToast;
