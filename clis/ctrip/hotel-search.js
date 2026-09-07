/**
 * 携程酒店 list — search hotels by city + date range.
 *
 * Reads `window.__NEXT_DATA__.props.pageProps.initListData.hotelList` directly
 * from the SSR-rendered hotel listing page. Ctrip serves first 13 hotels
 * (10 organic + ~3 promoted) inline; `&pageSize=N` URL params are ignored
 * server-side so we cap default limit accordingly (see
 * `~/.opencli/sites/ctrip/notes.md`).
 *
 * Reuses the existing `mapHotelRow` + `pickHotelMapCoords` helpers from utils.js
 * so the column shape stays consistent if future variants (hotel-detail) also
 * project from the same `hotelInfo` shape.
 *
 * Anti-bot: not detected on first-page navigation (PR #1481 recon 2026-05-12).
 */
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { fetchSuggest, mapHotelRow, parseCityId, parseIsoDate, parseStrictIntegerRange } from './utils.js';

const MIN_LIMIT = 1;
const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 10;

function parseHotelLimit(raw) {
    return parseStrictIntegerRange('limit', raw, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
}

/**
 * Wait for SSR state to be populated, or detect a login/captcha gate.
 *
 * Ctrip occasionally serves a captcha redirect (`/captcha`) when traffic
 * looks bot-like; we catch that as AuthRequired so the agent can pop a
 * human session instead of looping on an empty extract.
 */
const WAIT_FOR_SSR_JS = `
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

const EXTRACT_HOTELS_JS = `
  (() => {
    const list = window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList;
    if (!Array.isArray(list)) return null;
    return list;
  })()
`;

function buildDiscoveryExtractJs(limit) {
    return `
      (() => {
        const pageProps = window.__NEXT_DATA__?.props?.pageProps;
        const destination = pageProps?.searchBarData?.destinationInfo;
        const calendar = pageProps?.searchBarData?.calendarInfo;
        const requestDestination = pageProps?.initListRequest?.destination?.geo;
        const requestDates = pageProps?.initListRequest?.date?.dateInfo;
        const list = pageProps?.initListData?.hotelList;
        if (!Array.isArray(list)) return null;
        const cityId = Number(destination?.cityId);
        const requestCityId = Number(requestDestination?.cityId);
        const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
        const compactDate = (value) => {
          const match = /^(\\d{4})(\\d{2})(\\d{2})$/.exec(text(value) || '');
          return match ? match[1] + '-' + match[2] + '-' + match[3] : null;
        };
        const observedScope = {
          city_id: Number.isSafeInteger(cityId) && cityId > 0 ? cityId : null,
          city_name: text(destination?.cityName),
          destination_input_value: text(destination?.destinationInputValue),
          city_type: typeof destination?.cityType === 'string' || typeof destination?.cityType === 'number'
            ? destination.cityType : null,
          checkin: text(calendar?.checkIn),
          checkout: text(calendar?.checkOut),
          nights: Number.isSafeInteger(calendar?.nights) && calendar.nights > 0
            ? calendar.nights : null,
        };
        const scopeValid = observedScope.city_id !== null
          && observedScope.city_name !== null
          && observedScope.destination_input_value !== null
          && observedScope.city_type !== null
          && observedScope.checkin !== null
          && observedScope.checkout !== null
          && observedScope.nights !== null
          && Number.isSafeInteger(requestCityId)
          && requestCityId === observedScope.city_id
          && compactDate(requestDates?.checkInDate) === observedScope.checkin
          && compactDate(requestDates?.checkOutDate) === observedScope.checkout;
        const seen = new Set();
        const items = [];
        for (let index = 0; index < list.length && items.length < ${JSON.stringify(limit)}; index += 1) {
          const info = list[index]?.hotelInfo;
          const hotelId = String(info?.summary?.hotelId ?? '');
          const name = text(info?.nameInfo?.name);
          if (!/^\\d+$/.test(hotelId) || !name || seen.has(hotelId)) continue;
          seen.add(hotelId);
          const rating = Number(info?.commentInfo?.commentScore);
          const reviewDigits = String(info?.commentInfo?.commenterNumber ?? '').replace(/[^\\d]/g, '');
          const advertise = info?.advertiseInfo;
          const promoted = advertise?.isAdHotel === true || advertise?.isAdSolt === true
            ? true
            : advertise?.isAdHotel === false && advertise?.isAdSolt === false
              ? false
              : null;
          items.push({
            hotel_id: hotelId,
            name,
            url: 'https://hotels.ctrip.com/hotels/detail/?hotelid=' + hotelId,
            city: text(info?.positionInfo?.cityName),
            district: text(info?.positionInfo?.positionDesc),
            rating: Number.isFinite(rating) && rating > 0 ? rating : null,
            review_count: reviewDigits ? Number(reviewDigits) : null,
            position: index + 1,
            promoted,
          });
        }
        return { scope_valid: scopeValid, observed_scope: observedScope, items };
      })()
    `;
}

function destinationCandidates(rows) {
    const seen = new Set();
    const candidates = [];
    for (const row of rows) {
        if (!['City', 'IntlCity'].includes(row?.type)) continue;
        const cityId = Number(row.cityId);
        const name = typeof row.cityName === 'string' ? row.cityName.trim() : '';
        if (!Number.isSafeInteger(cityId) || cityId <= 0 || !name || seen.has(cityId)) continue;
        seen.add(cityId);
        candidates.push({
            city_id: cityId,
            name,
            province: typeof row.provinceName === 'string' && row.provinceName.trim() ? row.provinceName.trim() : null,
            country: typeof row.countryName === 'string' && row.countryName.trim() ? row.countryName.trim() : null,
        });
        if (candidates.length >= 5) break;
    }
    return candidates;
}

function assertCheckinBeforeCheckout(checkin, checkout) {
    if (Date.parse(checkin + 'T00:00:00Z') >= Date.parse(checkout + 'T00:00:00Z')) {
        throw new ArgumentError(`--checkin must be earlier than --checkout (got ${checkin} >= ${checkout})`);
    }
}

cli({
    site: 'ctrip',
    name: 'hotel-search',
    access: 'read',
    description: '搜索携程酒店列表（按城市 + 入住/离店日期）',
    domain: 'hotels.ctrip.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'city', required: false, positional: true, help: 'Numeric Ctrip city ID (use `ctrip search` or `ctrip hotel-suggest` to discover)' },
        { name: 'query', required: false, help: 'Destination query resolved to one Ctrip city inside this command' },
        { name: 'checkin', required: true, help: 'Check-in date (YYYY-MM-DD)' },
        { name: 'checkout', required: true, help: 'Check-out date (YYYY-MM-DD)' },
        { name: 'limit', default: DEFAULT_LIMIT, help: `Number of hotels (${MIN_LIMIT}-${MAX_LIMIT}); SSR first page returns ~13 entries` },
    ],
    columns: [
        'rank', 'hotelId', 'name', 'enName',
        'star', 'score', 'scoreLabel', 'reviewCount',
        'cityName', 'district', 'address',
        'lat', 'lon',
        'price', 'currency', 'url',
    ],
    func: async (page, kwargs) => {
        const checkin = parseIsoDate('checkin', kwargs.checkin);
        const checkout = parseIsoDate('checkout', kwargs.checkout);
        assertCheckinBeforeCheckout(checkin, checkout);
        const limit = parseHotelLimit(kwargs.limit);
        const hasQuery = typeof kwargs.query === 'string' && kwargs.query.trim() !== '';
        if (hasQuery && kwargs.city !== undefined && kwargs.city !== null && kwargs.city !== '') {
            throw new ArgumentError('Provide either positional city or --query, not both');
        }
        let cityId;
        let resolvedDestination = null;
        if (hasQuery) {
            const candidates = destinationCandidates(await fetchSuggest(kwargs.query.trim(), 'D'));
            if (candidates.length !== 1) {
                return {
                    outcome: candidates.length === 0 ? 'no_destination' : 'ambiguous_destination',
                    resolved_destination: null,
                    observed_scope: null,
                    items: [],
                    candidates,
                };
            }
            [resolvedDestination] = candidates;
            cityId = resolvedDestination.city_id;
        } else {
            cityId = parseCityId(kwargs.city);
        }

        const url = `https://hotels.ctrip.com/hotels/list?city=${cityId}&checkin=${checkin}&checkout=${checkout}`;
        await page.goto(url);
        const waitResult = await page.evaluate(WAIT_FOR_SSR_JS);
        if (waitResult === 'captcha') {
            throw new AuthRequiredError('hotels.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }
        if (waitResult !== 'content') {
            throw new CommandExecutionError(`Ctrip hotel-search page did not expose SSR hotel list (state=${String(waitResult)})`);
        }
        const raw = await page.evaluate(hasQuery ? buildDiscoveryExtractJs(limit) : EXTRACT_HOTELS_JS);
        if (hasQuery) {
            if (!raw || typeof raw !== 'object' || raw.scope_valid !== true
                || !raw.observed_scope || !Array.isArray(raw.items)) {
                throw new CommandExecutionError('Ctrip hotel-search observed scope was missing or inconsistent');
            }
            const expectedNights = (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000;
            if (raw.observed_scope.city_id !== cityId
                || raw.observed_scope.checkin !== checkin
                || raw.observed_scope.checkout !== checkout
                || raw.observed_scope.nights !== expectedNights) {
                throw new CommandExecutionError('Ctrip hotel-search observed scope did not match the request');
            }
            return {
                outcome: 'results',
                resolved_destination: resolvedDestination,
                observed_scope: raw.observed_scope,
                items: raw.items,
                candidates: [],
            };
        }
        if (!Array.isArray(raw)) {
            throw new CommandExecutionError('Ctrip hotel-search returned malformed SSR hotel list');
        }
        if (raw.length === 0) {
            throw new EmptyResultError('ctrip hotel-search', `No hotels for city=${cityId} on ${checkin} → ${checkout}`);
        }
        const rows = raw
            .map((entry, i) => mapHotelRow(entry, i))
            .filter((row) => row.hotelId && row.name)
            .slice(0, limit);
        if (rows.length === 0) {
            throw new CommandExecutionError('Ctrip hotel-search SSR rows were missing required hotelId/name anchors');
        }
        return rows;
    },
});

export const __test__ = {
    parseHotelLimit,
    assertCheckinBeforeCheckout,
    WAIT_FOR_SSR_JS,
    EXTRACT_HOTELS_JS,
    buildDiscoveryExtractJs,
    destinationCandidates,
};
