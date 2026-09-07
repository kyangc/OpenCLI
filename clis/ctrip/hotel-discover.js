/**
 * Resolve one destination city and return a verified, bounded hotel listing envelope.
 */
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    assertCheckinBeforeCheckout,
    DEFAULT_HOTEL_LIMIT,
    MAX_HOTEL_LIMIT,
    MIN_HOTEL_LIMIT,
    parseHotelLimit,
    WAIT_FOR_HOTEL_LIST_JS,
} from './hotel-list-shared.js';
import { fetchSuggest, parseIsoDate } from './utils.js';

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

cli({
    site: 'ctrip',
    name: 'hotel-discover',
    access: 'read',
    description: '按目的地名称解析城市并返回经页面范围验证的携程酒店候选',
    domain: 'hotels.ctrip.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    defaultFormat: 'json',
    args: [
        { name: 'query', required: true, help: 'Destination query resolved to one Ctrip city inside this command' },
        { name: 'checkin', required: true, help: 'Check-in date (YYYY-MM-DD)' },
        { name: 'checkout', required: true, help: 'Check-out date (YYYY-MM-DD)' },
        { name: 'limit', default: DEFAULT_HOTEL_LIMIT, help: `Number of hotels (${MIN_HOTEL_LIMIT}-${MAX_HOTEL_LIMIT}); SSR first page returns ~13 entries` },
    ],
    func: async (page, kwargs) => {
        const query = typeof kwargs.query === 'string' ? kwargs.query.trim() : '';
        if (!query) throw new ArgumentError('--query is required');
        const checkin = parseIsoDate('checkin', kwargs.checkin);
        const checkout = parseIsoDate('checkout', kwargs.checkout);
        assertCheckinBeforeCheckout(checkin, checkout);
        const limit = parseHotelLimit(kwargs.limit);
        const candidates = destinationCandidates(await fetchSuggest(query, 'D'));
        if (candidates.length !== 1) {
            return {
                outcome: candidates.length === 0 ? 'no_destination' : 'ambiguous_destination',
                resolved_destination: null,
                observed_scope: null,
                items: [],
                candidates,
            };
        }
        const [resolvedDestination] = candidates;
        const cityId = resolvedDestination.city_id;
        const url = `https://hotels.ctrip.com/hotels/list?city=${cityId}&checkin=${checkin}&checkout=${checkout}`;
        await page.goto(url);
        const waitResult = await page.evaluate(WAIT_FOR_HOTEL_LIST_JS);
        if (waitResult === 'captcha') {
            throw new AuthRequiredError('hotels.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }
        if (waitResult !== 'content') {
            throw new CommandExecutionError(`Ctrip hotel-discover page did not expose SSR hotel list (state=${String(waitResult)})`);
        }
        const raw = await page.evaluate(buildDiscoveryExtractJs(limit));
        if (!raw || typeof raw !== 'object' || raw.scope_valid !== true
            || !raw.observed_scope || !Array.isArray(raw.items)) {
            throw new CommandExecutionError('Ctrip hotel-discover observed scope was missing or inconsistent');
        }
        const expectedNights = (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000;
        if (raw.observed_scope.city_id !== cityId
            || raw.observed_scope.checkin !== checkin
            || raw.observed_scope.checkout !== checkout
            || raw.observed_scope.nights !== expectedNights) {
            throw new CommandExecutionError('Ctrip hotel-discover observed scope did not match the request');
        }
        return {
            outcome: 'results',
            resolved_destination: resolvedDestination,
            observed_scope: raw.observed_scope,
            items: raw.items,
            candidates: [],
        };
    },
});

export const __test__ = { buildDiscoveryExtractJs, destinationCandidates };
