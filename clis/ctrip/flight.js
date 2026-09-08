/**
 * 携程机票 oneway search — domestic + international flight search by route + date.
 *
 * Flight rows arrive in the page's natural `batchSearch` response. Capture that
 * response through CDP so Ctrip remains responsible for request parameters,
 * trace ids, risk controls, and session state; do not reconstruct its request.
 *
 * Round-trip search lives in the sibling `flight-round` command; advanced filters
 * (airline whitelist, cabin selection beyond 全舱位) remain out of scope here.
 */
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { parseIataCode, parseIsoDate, parseStrictIntegerRange } from './utils.js';

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const CAPTURE_PATTERN = '/international/search/api/search/batchSearch';
const CAPTURE_TIMEOUT_SECONDS = 12;
const CAPTURE_TIMEOUT_MS = CAPTURE_TIMEOUT_SECONDS * 1000;
const NO_CAPTURE_TIMEOUT_MESSAGE = 'No completed batchSearch response was captured within 12s after navigation.';
const PARTIAL_CAPTURE_TIMEOUT_MESSAGE = 'Ctrip returned partial flight batches but did not report search completion within 12s after navigation; partial results were not returned.';
const NO_CAPTURE_TIMEOUT_HINT = 'Retry the search or try again later.';
const PARTIAL_CAPTURE_TIMEOUT_HINT = 'Partial results were not returned. Retry the search or try again later.';
const UNSAFE_CAPTURE_MESSAGE = 'Ctrip flight batchSearch response could not be safely processed.';
const CHECK_CAPTCHA_JS = `
  (() => location.pathname.includes('captcha') || /验证码|verify the human|安全验证/i.test(document.body?.innerText || '') ? 'captcha' : null)()
`;

function parseFlightLimit(raw) {
    return parseStrictIntegerRange('limit', raw, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function timePart(value) {
    const match = cleanString(value).match(/(?:^|\s)([0-2]\d:[0-5]\d)(?::[0-5]\d)?$/);
    return match?.[1] || '';
}

function cabinLabel(value) {
    const labels = { Y: '经济舱', S: '超级经济舱', C: '公务舱', F: '头等舱' };
    const codes = [...new Set(cleanString(value).toUpperCase().match(/[YSCF]/g) || [])];
    return codes.length > 0 ? codes.map((code) => labels[code]).join('/') : (cleanString(value) || null);
}

function parseBatchSearchCaptures(entries) {
    if (!Array.isArray(entries)) {
        throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
    }
    const captured = entries.filter((entry) => String(entry?.url || '').includes(CAPTURE_PATTERN));
    if (captured.length === 0) return null;

    const parsedItineraries = [];
    let finished = false;
    for (const entry of captured) {
        const status = Number(entry?.responseStatus || 0);
        if (status === 401 || status === 403) {
            throw new AuthRequiredError('flights.ctrip.com', 'Ctrip flight API requires authentication or verification.');
        }
        if (status !== 200) {
            throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
        }
        if (entry?.responseBodyMissing === true || entry?.responseBodyTruncated === true ||
            typeof entry?.responsePreview !== 'string') {
            throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
        }
        let payload;
        try {
            payload = JSON.parse(entry.responsePreview);
        }
        catch {
            throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
        }
        if (payload?.status !== 0) {
            throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
        }
        const itineraries = payload?.data?.flightItineraryList;
        if (!Array.isArray(itineraries) || typeof payload?.data?.context?.finished !== 'boolean') {
            throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
        }
        for (const itinerary of itineraries) {
            const id = cleanString(itinerary?.itineraryId);
            if (!id) throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
            // Keep only parsed itineraries; raw capture entries and bodies are
            // released after each drain.
            parsedItineraries.push(itinerary);
        }
        finished ||= payload.data.context.finished;
    }
    return { itineraries: parsedItineraries, finished };
}

function captureTimeout(hasPartialBatch) {
    const error = new TimeoutError(
        'Ctrip flight batchSearch capture',
        CAPTURE_TIMEOUT_SECONDS,
        hasPartialBatch ? PARTIAL_CAPTURE_TIMEOUT_HINT : NO_CAPTURE_TIMEOUT_HINT,
    );
    error.message = hasPartialBatch ? PARTIAL_CAPTURE_TIMEOUT_MESSAGE : NO_CAPTURE_TIMEOUT_MESSAGE;
    return error;
}

function mapItinerary(itinerary, searchUrl) {
    const segments = itinerary?.flightSegments;
    const prices = itinerary?.priceList;
    if (!Array.isArray(segments) || segments.length === 0 || !Array.isArray(prices) || prices.length === 0) {
        throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
    }
    const legs = segments.flatMap((segment) => Array.isArray(segment?.flightList) ? segment.flightList : []);
    const first = legs[0];
    const last = legs.at(-1);
    const airline = [...new Set(segments.map((segment) => cleanString(segment?.airlineName)).filter(Boolean))].join(' / ');
    const flightNo = [...new Set(legs.map((leg) => cleanString(leg?.flightNo)).filter(Boolean))].join(' / ');
    const aircraft = [...new Set(legs.map((leg) => cleanString(leg?.aircraftName)).filter(Boolean))].join(' / ') || null;
    const departureTime = timePart(first?.departureDateTime);
    const arrivalTime = timePart(last?.arrivalDateTime);
    const departureAirport = cleanString(first?.departureAirportName);
    const arrivalAirport = cleanString(last?.arrivalAirportName);
    const price = Number(prices[0]?.sortPrice ?? prices[0]?.adultPrice);
    if (!airline || !flightNo || !departureTime || !arrivalTime || !departureAirport || !arrivalAirport || !Number.isFinite(price)) {
        throw new CommandExecutionError(UNSAFE_CAPTURE_MESSAGE);
    }
    const row = {
        airline,
        flightNo,
        aircraft,
        departureTime,
        departureAirport,
        arrivalTime,
        arrivalAirport,
        terminal: cleanString(last?.arrivalTerminal) || null,
        price,
        currency: '¥',
        cabin: cabinLabel(prices[0]?.cabin),
        url: searchUrl,
    };
    const isConnecting = legs.length > 1 || segments.some((segment) => Number(segment?.transferCount || 0) > 0);
    return [row, isConnecting, cleanString(first?.departureDateTime), cleanString(itinerary.itineraryId)];
}

cli({
    site: 'ctrip',
    name: 'flight',
    access: 'read',
    description: '搜索携程一程机票（按出发/到达 IATA 三字码 + 日期）',
    domain: 'flights.ctrip.com',
    strategy: Strategy.INTERCEPT,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'from', required: true, positional: true, help: 'Departure IATA code (e.g. BJS / PEK)' },
        { name: 'to', required: true, positional: true, help: 'Arrival IATA code (e.g. SHA / PVG)' },
        { name: 'date', required: true, help: 'Departure date (YYYY-MM-DD)' },
        { name: 'limit', default: DEFAULT_LIMIT, help: `Number of flights (${MIN_LIMIT}-${MAX_LIMIT})` },
    ],
    columns: [
        'rank',
        'airline', 'flightNo', 'aircraft',
        'departureTime', 'departureAirport',
        'arrivalTime', 'arrivalAirport', 'terminal',
        'price', 'currency', 'cabin',
        'url',
    ],
    func: async (page, kwargs) => {
        const fromCode = parseIataCode('from', kwargs.from);
        const toCode = parseIataCode('to', kwargs.to);
        if (fromCode === toCode) {
            throw new ArgumentError(`--from and --to must differ (got ${fromCode})`);
        }
        const date = parseIsoDate('date', kwargs.date);
        const limit = parseFlightLimit(kwargs.limit);

        const searchUrl =
            `https://flights.ctrip.com/online/list/oneway-${fromCode.toLowerCase()}-${toCode.toLowerCase()}` +
            `?depdate=${date}&cabin=Y_S_C_F&adult=1&child=0&infant=0`;
        if (typeof page?.startNetworkCapture !== 'function' ||
            typeof page?.readNetworkCapture !== 'function' ||
            !await page.startNetworkCapture(CAPTURE_PATTERN)) {
            throw new CommandExecutionError('Ctrip flight requires browser response interception');
        }
        await page.readNetworkCapture();
        await page.goto(searchUrl);
        const captureDeadline = performance.now() + CAPTURE_TIMEOUT_MS;
        if (await page.evaluate(CHECK_CAPTCHA_JS) === 'captcha') {
            throw new AuthRequiredError('flights.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }

        const itinerariesById = new Map();
        let sawPartialBatch = false;
        let itineraries;
        while (true) {
            if (performance.now() >= captureDeadline) {
                throw captureTimeout(sawPartialBatch);
            }
            const entries = await page.readNetworkCapture();
            if (performance.now() >= captureDeadline) {
                throw captureTimeout(sawPartialBatch);
            }
            const batch = parseBatchSearchCaptures(entries);
            if (batch) {
                for (const itinerary of batch.itineraries) {
                    itinerariesById.set(cleanString(itinerary.itineraryId), itinerary);
                }
                if (batch.finished) {
                    itineraries = [...itinerariesById.values()];
                    break;
                }
                sawPartialBatch = true;
            }

            const remainingMs = captureDeadline - performance.now();
            if (remainingMs <= 0) {
                throw captureTimeout(sawPartialBatch);
            }
            await page.sleep(Math.min(0.5, remainingMs / 1000));
        }
        if (itineraries.length === 0) {
            throw new EmptyResultError('ctrip flight', `No flights for ${fromCode}→${toCode} on ${date}`);
        }
        const rows = itineraries
            .map((itinerary) => mapItinerary(itinerary, searchUrl))
            // The page groups direct flights before transfers, then applies its
            // displayed starting price and departure-time order inside each group.
            .sort(([rowA, connectingA, departureA, idA], [rowB, connectingB, departureB, idB]) =>
                Number(connectingA) - Number(connectingB) || rowA.price - rowB.price ||
                departureA.localeCompare(departureB) || idA.localeCompare(idB))
            .slice(0, limit)
            .map(([row], index) => ({
                rank: index + 1,
                airline: row.airline,
                flightNo: row.flightNo,
                aircraft: row.aircraft,
                departureTime: row.departureTime,
                departureAirport: row.departureAirport,
                arrivalTime: row.arrivalTime,
                arrivalAirport: row.arrivalAirport,
                terminal: row.terminal,
                price: row.price,
                currency: row.currency,
                cabin: row.cabin,
                url: row.url,
            }));
        return rows;
    },
});

export const __test__ = { parseFlightLimit };
