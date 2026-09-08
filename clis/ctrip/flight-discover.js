/**
 * Bounded one-way flight discovery from the first screen after one top reset.
 * It never scrolls downward to load more results.
 */
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { parseIataCode, parseIsoDate, parseStrictIntegerRange } from './utils.js';

const MAX_DISCOVERY_ITEMS = 5;
const DISCOVERY_ERROR = 'Ctrip flight-discover page evidence was missing or inconsistent';
const RESET_TO_TOP_JS = '(() => { window.scrollTo(0, 0); return true; })()';
const WAIT_FOR_DISCOVERY_JS = `
  new Promise((resolve) => {
    const visible = (element) => {
      if (!element) return false;
      let ancestor = element;
      let depth = 0;
      while (ancestor && depth < 64) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (ancestor === document.documentElement) break;
        ancestor = ancestor.parentElement;
        depth += 1;
      }
      if (ancestor !== document.documentElement) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    };
    const detect = () => {
      if (location.pathname.includes('captcha') || /验证码|verify the human|安全验证/i.test(document.body?.innerText || '')) return 'captcha';
      if ([...document.querySelectorAll('.flight-item')].some(visible)) return 'content';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 12000);
  })
`;

function buildFlightDiscoveryExtractJs(requestedScope, limit) {
    const requestedJson = JSON.stringify(requestedScope);
    const boundedLimit = Math.min(MAX_DISCOVERY_ITEMS, Math.max(1, Number(limit) || MAX_DISCOVERY_ITEMS));
    return `(() => {
      const requested = ${requestedJson};
      const limit = ${boundedLimit};
      const clean = (value) => String(value || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim();
      if (document.location.pathname.includes('captcha') || /验证码|verify the human|安全验证/i.test(document.body?.innerText || document.body?.textContent || '')) {
        return { captcha: true };
      }
      const stylesVisibleThrough = (element, boundary) => {
        let ancestor = element;
        let depth = 0;
        while (ancestor && depth < 64) {
          const style = getComputedStyle(ancestor);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          if (ancestor === boundary) return true;
          ancestor = ancestor.parentElement;
          depth += 1;
        }
        return false;
      };
      const visible = (element) => {
        if (!element) return false;
        if (!stylesVisibleThrough(element, document.documentElement)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      };
      const visibleText = (selector, root = document) => {
        const element = root.querySelector(selector);
        return visible(element) ? clean(element.textContent) : null;
      };
      const iataFrom = (value) => {
        const matches = [...String(value || '').matchAll(/\\(([A-Z]{3})\\)/g)];
        return matches.length ? matches[matches.length - 1][1] : null;
      };
      const form = document.querySelector('form#searchForm');
      const originInput = form?.querySelector('input[name="owDCity"]');
      const destinationInput = form?.querySelector('input[name="owACity"]');
      const dateInput = form?.querySelector('#datePicker input[aria-label="请选择日期"]');
      const activeTrip = form?.querySelector('li.active');
      const origin = visible(originInput) ? iataFrom(originInput.value) : null;
      const destination = visible(destinationInput) ? iataFrom(destinationInput.value) : null;
      const departureDate = visible(dateInput) ? clean(dateInput.value) : null;
      const tripType = visible(activeTrip) && clean(activeTrip.textContent).includes('单程') ? 'one_way' : null;
      const passengerCounts = { adults: null, children: null, infants: null };
      for (const span of form?.querySelectorAll('span') || []) {
        if (!visible(span)) continue;
        const match = clean(span.textContent).match(/^(\\d+)(成人|儿童|婴儿)$/);
        if (!match) continue;
        const field = match[2] === '成人' ? 'adults' : match[2] === '儿童' ? 'children' : 'infants';
        passengerCounts[field] = Number(match[1]);
      }
      const cabinFilterLabel = visibleText('.flt-subclass .form-select-v3', form);
      const timeHint = visibleText('.result-header .hint');
      const timeBasis = timeHint?.includes('当地时间') ? 'page_displayed_local_time' : null;
      const observedScope = {
        origin,
        destination,
        departure_date: departureDate,
        trip_type: tripType,
        adults: passengerCounts.adults,
        children: passengerCounts.children,
        infants: passengerCounts.infants,
        cabin_filter_label: cabinFilterLabel,
        time_basis: timeBasis,
      };
      const scopeValid = origin === requested.origin && destination === requested.destination
        && departureDate === requested.departure_date && tripType === 'one_way'
        && passengerCounts.adults === 1 && passengerCounts.children === 0 && passengerCounts.infants === 0
        && Boolean(cabinFilterLabel) && timeBasis === 'page_displayed_local_time';

      const countText = visibleText('.recommend-box.header .total');
      const totalMatch = countText?.match(/共\\s*(\\d+)\\s*个航班/);
      const directMatch = countText?.match(/[，,]\\s*(\\d+)\\s*个直飞/);
      const pageReportedCounts = totalMatch ? {
        total_results: Number(totalMatch[1]),
        ...(directMatch ? { direct_results: Number(directMatch[1]) } : {}),
      } : null;
      const sortLabel = visibleText('.sortbar-v2 .sort-item.active');

      const addDays = (date, days) => {
        const parsed = new Date(date + 'T00:00:00Z');
        if (Number.isNaN(parsed.getTime())) return null;
        parsed.setUTCDate(parsed.getUTCDate() + days);
        return parsed.toISOString().slice(0, 10);
      };
      const tokensOf = (card) => {
        const rawTokens = [];
        const walker = card.ownerDocument.createTreeWalker(card, 4);
        let node;
        while ((node = walker.nextNode())) {
          if (!stylesVisibleThrough(node.parentElement, card)) continue;
          rawTokens.push(...clean(node.nodeValue).split(' ').filter(Boolean));
        }
        const tokens = [];
        for (let index = 0; index < rawTokens.length; index += 1) {
          if (/^\\+\\d+$/.test(rawTokens[index]) && rawTokens[index + 1] === '天') {
            tokens.push(rawTokens[index] + '天');
            index += 1;
          } else {
            tokens.push(rawTokens[index]);
          }
        }
        return tokens;
      };
      const timePattern = /^(?:[01]\\d|2[0-3]):[0-5]\\d$/;
      const flightPattern = /^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2}\\d{3,4}[A-Z]?$/;
      const durationPattern = /^(?=.+(?:天|小时|时|分))(?:(?:\\d+天)?(?:\\d+(?:小时|时))?(?:\\d+分)?)$/;
      const airportAfter = (tokens, timeIndex) => {
        for (let index = timeIndex + 1; index < tokens.length; index += 1) {
          const token = tokens[index];
          if (timePattern.test(token)) break;
          if (/机场$/.test(token)) return token;
        }
        return null;
      };
      const items = [];
      for (const card of document.querySelectorAll('.flight-item')) {
        if (items.length >= limit) break;
        if (!visible(card)) continue;
        const tokens = tokensOf(card);
        const timeIndexes = tokens.map((token, index) => timePattern.test(token) ? index : -1).filter((index) => index >= 0);
        if (tokens.length === 0 || timeIndexes.length < 2) continue;
        const departureIndex = timeIndexes[0];
        const arrivalIndex = timeIndexes[timeIndexes.length - 1];
        const flightNumbers = tokens.slice(0, departureIndex).filter((token) => flightPattern.test(token));
        const dayMarker = tokens.slice(arrivalIndex + 1).find((token) => /^\\+\\d+天$/.test(token));
        const dayOffset = dayMarker ? Number(dayMarker.match(/\\d+/)[0]) : 0;
        const duration = [...tokens].reverse().find((token) => durationPattern.test(token)) || null;
        const transferText = tokens.find((token) => /^转\\d+次$/.test(token));
        const directText = tokens.find((token) => token === '直飞');
        const departureAirport = airportAfter(tokens, departureIndex);
        const arrivalAirport = airportAfter(tokens, arrivalIndex);
        if (!departureAirport || !arrivalAirport) continue;
        items.push({
          airline: tokens[0] || null,
          flight_number: flightNumbers.length ? flightNumbers.join(' / ') : null,
          departure_datetime: requested.departure_date + ' ' + tokens[departureIndex],
          departure_airport: departureAirport,
          arrival_datetime: addDays(requested.departure_date, dayOffset) + ' ' + tokens[arrivalIndex],
          arrival_airport: arrivalAirport,
          overnight: dayOffset > 0,
          connection_type: transferText ? 'connecting' : directText ? 'direct' : null,
          duration,
        });
      }
      return {
        scope_valid: scopeValid,
        observed_scope: observedScope,
        page_reported_counts: pageReportedCounts,
        sort_label: sortLabel,
        items,
      };
    })()`;
}

function cleanString(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
    return cleaned || null;
}

function isValidObservedDatetime(value) {
    const match = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value || '');
    if (!match) return false;
    const parsed = new Date(`${match[1]}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1];
}

function isCredibleAirport(value) {
    return typeof value === 'string' && /机场$/.test(value.trim());
}

function normalizeDiscoveryItem(item) {
    const airline = cleanString(item?.airline);
    const departureDatetime = cleanString(item?.departure_datetime);
    const departureAirport = cleanString(item?.departure_airport);
    const arrivalDatetime = cleanString(item?.arrival_datetime);
    const arrivalAirport = cleanString(item?.arrival_airport);
    if (!airline || !isValidObservedDatetime(departureDatetime) || !isCredibleAirport(departureAirport) ||
        !isValidObservedDatetime(arrivalDatetime) || !isCredibleAirport(arrivalAirport)) {
        throw new CommandExecutionError(DISCOVERY_ERROR);
    }
    const connectionType = item?.connection_type;
    if (![null, 'direct', 'connecting'].includes(connectionType)) {
        throw new CommandExecutionError(DISCOVERY_ERROR);
    }
    if (![null, true, false].includes(item?.overnight)) {
        throw new CommandExecutionError(DISCOVERY_ERROR);
    }
    return {
        airline,
        flight_number: cleanString(item?.flight_number),
        departure_datetime: departureDatetime,
        departure_airport: departureAirport,
        arrival_datetime: arrivalDatetime,
        arrival_airport: arrivalAirport,
        overnight: item.overnight,
        connection_type: connectionType,
        duration: cleanString(item?.duration),
    };
}

cli({
    site: 'ctrip',
    name: 'flight-discover',
    access: 'read',
    description: '返回携程单程页重置到顶部后的首屏可见航班候选（不向下滚动加载更多，不含报价）',
    domain: 'flights.ctrip.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    defaultFormat: 'json',
    args: [
        { name: 'from', required: true, positional: true, help: 'Departure IATA code (e.g. BJS / PEK)' },
        { name: 'to', required: true, positional: true, help: 'Arrival IATA code (e.g. SHA / PVG)' },
        { name: 'date', required: true, help: 'Departure date (YYYY-MM-DD)' },
        { name: 'limit', default: 5, help: 'Number of visible candidates (1-5)' },
    ],
    func: async (page, kwargs) => {
        const origin = parseIataCode('from', kwargs.from);
        const destination = parseIataCode('to', kwargs.to);
        if (origin === destination) {
            throw new ArgumentError(`--from and --to must differ (got ${origin})`);
        }
        const departureDate = parseIsoDate('date', kwargs.date);
        const limit = parseStrictIntegerRange('limit', kwargs.limit, MAX_DISCOVERY_ITEMS, 1, MAX_DISCOVERY_ITEMS);
        const requestedScope = {
            origin,
            destination,
            departure_date: departureDate,
        };
        const searchUrl =
            `https://flights.ctrip.com/online/list/oneway-${origin.toLowerCase()}-${destination.toLowerCase()}` +
            `?depdate=${departureDate}&cabin=Y_S_C_F&adult=1&child=0&infant=0`;
        await page.goto(searchUrl);
        await page.evaluate(RESET_TO_TOP_JS);
        const readiness = await page.evaluate(WAIT_FOR_DISCOVERY_JS);
        if (readiness === 'captcha') {
            throw new AuthRequiredError('flights.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }
        if (readiness !== 'content') {
            throw new CommandExecutionError(DISCOVERY_ERROR);
        }
        const raw = await page.evaluate(buildFlightDiscoveryExtractJs(requestedScope, limit));
        if (raw?.captcha === true) {
            throw new AuthRequiredError('flights.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }
        if (!raw || typeof raw !== 'object' || raw.scope_valid !== true ||
            !raw.observed_scope || !Array.isArray(raw.items) || raw.items.length === 0) {
            throw new CommandExecutionError(DISCOVERY_ERROR);
        }
        const scope = raw.observed_scope;
        if (scope.origin !== origin || scope.destination !== destination ||
            scope.departure_date !== departureDate || scope.trip_type !== 'one_way' ||
            scope.adults !== 1 || scope.children !== 0 || scope.infants !== 0 ||
            !cleanString(scope.cabin_filter_label) || scope.time_basis !== 'page_displayed_local_time') {
            throw new CommandExecutionError(DISCOVERY_ERROR);
        }
        const pageReportedCounts = raw.page_reported_counts;
        if (pageReportedCounts !== null && (typeof pageReportedCounts !== 'object' ||
            !Number.isSafeInteger(pageReportedCounts.total_results) || pageReportedCounts.total_results < 0 ||
            (pageReportedCounts.direct_results !== undefined &&
                (!Number.isSafeInteger(pageReportedCounts.direct_results) || pageReportedCounts.direct_results < 0)))) {
            throw new CommandExecutionError(DISCOVERY_ERROR);
        }
        const sortLabel = cleanString(raw.sort_label);
        const normalizedCounts = pageReportedCounts === null ? null : {
            total_results: pageReportedCounts.total_results,
            ...(pageReportedCounts.direct_results === undefined ? {} : { direct_results: pageReportedCounts.direct_results }),
        };
        return {
            outcome: 'results',
            requested_scope: requestedScope,
            observed_scope: {
                origin: scope.origin,
                destination: scope.destination,
                departure_date: scope.departure_date,
                trip_type: scope.trip_type,
                adults: scope.adults,
                children: scope.children,
                infants: scope.infants,
                cabin_filter_label: cleanString(scope.cabin_filter_label),
                time_basis: scope.time_basis,
            },
            coverage: 'observed_initial_results',
            page_reported_counts: normalizedCounts,
            sort_label: sortLabel,
            items: raw.items.slice(0, limit).map(normalizeDiscoveryItem),
        };
    },
});

export const __test__ = { buildFlightDiscoveryExtractJs, RESET_TO_TOP_JS, WAIT_FOR_DISCOVERY_JS };
