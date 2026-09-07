import { ArgumentError } from '@jackwener/opencli/errors';
import { parseStrictIntegerRange } from './utils.js';

export const MIN_HOTEL_LIMIT = 1;
export const MAX_HOTEL_LIMIT = 30;
export const DEFAULT_HOTEL_LIMIT = 10;

export function parseHotelLimit(raw) {
    return parseStrictIntegerRange(
        'limit', raw, DEFAULT_HOTEL_LIMIT, MIN_HOTEL_LIMIT, MAX_HOTEL_LIMIT,
    );
}

export function assertCheckinBeforeCheckout(checkin, checkout) {
    if (Date.parse(checkin + 'T00:00:00Z') >= Date.parse(checkout + 'T00:00:00Z')) {
        throw new ArgumentError(`--checkin must be earlier than --checkout (got ${checkin} >= ${checkout})`);
    }
}

/** Wait for SSR state, while surfacing Ctrip's login/captcha gate. */
export const WAIT_FOR_HOTEL_LIST_JS = `
  new Promise((resolve) => {
    const detect = () => {
      if (location.pathname.includes('captcha') || /验证码|verify the human/i.test(document.body?.innerText || '')) return 'captcha';
      const hotels = window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList;
      if (Array.isArray(hotels)) return 'content';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })
`;
