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
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    assertCheckinBeforeCheckout,
    DEFAULT_HOTEL_LIMIT,
    MAX_HOTEL_LIMIT,
    MIN_HOTEL_LIMIT,
    parseHotelLimit,
    WAIT_FOR_HOTEL_LIST_JS,
} from './hotel-list-shared.js';
import { mapHotelRow, parseCityId, parseIsoDate } from './utils.js';

const EXTRACT_HOTELS_JS = `
  (() => {
    const list = window.__NEXT_DATA__?.props?.pageProps?.initListData?.hotelList;
    if (!Array.isArray(list)) return null;
    return list;
  })()
`;

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
        { name: 'city', required: true, positional: true, help: 'Numeric Ctrip city ID (use `ctrip search` or `ctrip hotel-suggest` to discover)' },
        { name: 'checkin', required: true, help: 'Check-in date (YYYY-MM-DD)' },
        { name: 'checkout', required: true, help: 'Check-out date (YYYY-MM-DD)' },
        { name: 'limit', default: DEFAULT_HOTEL_LIMIT, help: `Number of hotels (${MIN_HOTEL_LIMIT}-${MAX_HOTEL_LIMIT}); SSR first page returns ~13 entries` },
    ],
    columns: [
        'rank', 'hotelId', 'name', 'enName',
        'star', 'score', 'scoreLabel', 'reviewCount',
        'cityName', 'district', 'address',
        'lat', 'lon',
        'price', 'currency', 'url',
    ],
    func: async (page, kwargs) => {
        const cityId = parseCityId(kwargs.city);
        const checkin = parseIsoDate('checkin', kwargs.checkin);
        const checkout = parseIsoDate('checkout', kwargs.checkout);
        assertCheckinBeforeCheckout(checkin, checkout);
        const limit = parseHotelLimit(kwargs.limit);

        const url = `https://hotels.ctrip.com/hotels/list?city=${cityId}&checkin=${checkin}&checkout=${checkout}`;
        await page.goto(url);
        const waitResult = await page.evaluate(WAIT_FOR_HOTEL_LIST_JS);
        if (waitResult === 'captcha') {
            throw new AuthRequiredError('hotels.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }
        if (waitResult !== 'content') {
            throw new CommandExecutionError(`Ctrip hotel-search page did not expose SSR hotel list (state=${String(waitResult)})`);
        }
        const raw = await page.evaluate(EXTRACT_HOTELS_JS);
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
    WAIT_FOR_SSR_JS: WAIT_FOR_HOTEL_LIST_JS,
    EXTRACT_HOTELS_JS,
};
