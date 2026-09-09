/**
 * Bounded one-way flight discovery across actually visible result cards.
 */
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { parseIataCode, parseIsoDate, parseStrictIntegerRange } from './utils.js';

const DEFAULT_DISCOVERY_ITEMS = 20;
const MAX_DISCOVERY_ITEMS = 40;
const DISCOVERY_WAIT_SECONDS = 20;
const DISCOVERY_DEADLINE_MS = 45000;
const DISCOVERY_SCROLL_LIMIT = 12;
const DISCOVERY_SCOPE_ERROR = 'Ctrip flight-discover visible search scope was missing or did not match the request';
const DISCOVERY_OUTPUT_ERROR = 'Ctrip flight-discover visible flight-card extraction returned invalid output';

function buildFlightDiscoveryExtractJs(requestedScope, limit) {
    const requestedJson = JSON.stringify(requestedScope);
    const boundedLimit = Math.min(MAX_DISCOVERY_ITEMS, Math.max(1, Number(limit) || DEFAULT_DISCOVERY_ITEMS));
    return `new Promise((resolve) => {
      const collect = async () => {
      const requested = ${requestedJson};
      const limit = ${boundedLimit};
      const startedAt = performance.now();
      const deadline = startedAt + ${DISCOVERY_DEADLINE_MS};
      const readinessDeadline = Math.min(deadline, startedAt + ${DISCOVERY_WAIT_SECONDS * 1000});
      const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
      window.scrollTo(0, 0);
      const clean = (value) => String(value || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim();
      const hasCaptcha = () => document.location.pathname.includes('captcha') ||
        /验证码|verify the human|安全验证/i.test(document.body?.innerText || document.body?.textContent || '');
      if (hasCaptcha()) return resolve({ captcha: true });
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
      const readScope = (requireVisible) => {
        const form = document.querySelector('form#searchForm');
        const originInput = form?.querySelector('input[name="owDCity"]');
        const destinationInput = form?.querySelector('input[name="owACity"]');
        const dateInput = form?.querySelector('#datePicker input[aria-label="请选择日期"]');
        const activeTrip = form?.querySelector('li.active');
        const cabin = form?.querySelector('.flt-subclass .form-select-v3');
        const timeHint = document.querySelector('.result-header .hint');
        const readable = (element) => Boolean(element) && (!requireVisible || visible(element));
        const passengerCounts = { adults: null, children: null, infants: null };
        for (const span of form?.querySelectorAll('span') || []) {
          if (!readable(span)) continue;
          const match = clean(span.textContent).match(/^(\\d+)(成人|儿童|婴儿)$/);
          if (!match) continue;
          const field = match[2] === '成人' ? 'adults' : match[2] === '儿童' ? 'children' : 'infants';
          passengerCounts[field] = Number(match[1]);
        }
        return {
          origin: readable(originInput) ? iataFrom(originInput.value) : null,
          destination: readable(destinationInput) ? iataFrom(destinationInput.value) : null,
          departure_date: readable(dateInput) ? clean(dateInput.value) : null,
          trip_type: readable(activeTrip) && clean(activeTrip.textContent).includes('单程') ? 'one_way' : null,
          adults: passengerCounts.adults,
          children: passengerCounts.children,
          infants: passengerCounts.infants,
          cabin_filter_label: readable(cabin) ? clean(cabin.textContent) : null,
          time_basis: readable(timeHint) && clean(timeHint.textContent).includes('当地时间')
            ? 'page_displayed_local_time' : null,
        };
      };
      const scopeMatches = (scope) => scope.origin === requested.origin && scope.destination === requested.destination
        && scope.departure_date === requested.departure_date && scope.trip_type === 'one_way'
        && scope.adults === 1 && scope.children === 0 && scope.infants === 0
        && Boolean(scope.cabin_filter_label) && scope.time_basis === 'page_displayed_local_time';
      let observedScope;
      while (true) {
        if (hasCaptcha()) return resolve({ captcha: true });
        const hasVisibleCard = [...document.querySelectorAll('.flight-item')].some(visible);
        const currentScope = readScope(true);
        if (performance.now() >= readinessDeadline) {
          if (!hasVisibleCard) return resolve({ initial_timeout: true });
          return resolve({
            scope_valid: false,
            scope_readiness_failure: true,
            observed_scope: currentScope,
            items: [],
          });
        }
        if (hasVisibleCard && scopeMatches(currentScope)) {
          observedScope = currentScope;
          break;
        }
        await sleep(Math.min(250, readinessDeadline - performance.now()));
      }
      const sameScope = (left, right) => left.origin === right.origin && left.destination === right.destination
        && left.departure_date === right.departure_date && left.trip_type === right.trip_type
        && left.adults === right.adults && left.children === right.children && left.infants === right.infants
        && left.cabin_filter_label === right.cabin_filter_label && left.time_basis === right.time_basis;

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
      const hasLineThrough = (element, boundary) => {
        let current = element;
        while (current) {
          const style = getComputedStyle(current);
          if (String(style.textDecorationLine || '').includes('line-through') ||
              String(style.textDecoration || '').includes('line-through')) return true;
          if (current === boundary) return false;
          current = current.parentElement;
        }
        return true;
      };
      const currentTextOf = (element, excluded = null) => {
        const chunks = [];
        const walker = element.ownerDocument.createTreeWalker(element, 4);
        let node;
        while ((node = walker.nextNode())) {
          if (excluded?.contains(node.parentElement)) continue;
          if (!visible(node.parentElement) || hasLineThrough(node.parentElement, element)) continue;
          chunks.push(node.nodeValue);
        }
        return clean(chunks.join(''));
      };
      const displayedPriceOf = (card) => {
        const regions = [...card.querySelectorAll('.flight-price')]
          .filter((region) => visible(region) && !hasLineThrough(region, card));
        if (regions.length !== 1) return null;
        const region = regions[0];
        const current = (selector) => [...region.querySelectorAll(selector)]
          .filter((element) => visible(element) && !hasLineThrough(element, region));
        const currentPrices = current('.price');
        const prices = currentPrices.filter((candidate) =>
          !currentPrices.some((other) => other !== candidate && candidate.contains(other)));
        const qualifiers = current('.qi');
        const taxes = current('.tip');
        if (prices.length !== 1 || qualifiers.length !== 1 || taxes.length !== 1) return null;
        const [price] = prices;
        const [qualifier] = qualifiers;
        const [tax] = taxes;
        const extraPriceText = currentPrices
          .filter((candidate) => candidate !== price)
          .map((candidate) => currentTextOf(candidate, price))
          .join('');
        if (/¥\\s*[1-9]\\d{0,8}(?:\\.\\d{1,2})?/.test(extraPriceText)) return null;
        const amount = currentTextOf(price).match(/^¥\\s*([1-9]\\d{0,8}(?:\\.\\d{1,2})?)$/)?.[1];
        if (!amount || currentTextOf(qualifier) !== '起' || currentTextOf(tax) !== '含税价') return null;
        return {
          amount,
          currency_symbol: '¥',
          qualifier: 'starting',
          tax_inclusion: 'included',
          passenger_basis: 'unknown',
        };
      };
      const parseCard = (card) => {
        const tokens = tokensOf(card);
        const timeIndexes = tokens.map((token, index) => timePattern.test(token) ? index : -1).filter((index) => index >= 0);
        if (tokens.length === 0 || timeIndexes.length < 2) return null;
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
        if (flightNumbers.length === 0 || !departureAirport || !arrivalAirport) return null;
        return {
          airline: tokens[0] || null,
          flight_number: flightNumbers.join(' / '),
          departure_datetime: requested.departure_date + ' ' + tokens[departureIndex],
          departure_airport: departureAirport,
          arrival_datetime: addDays(requested.departure_date, dayOffset) + ' ' + tokens[arrivalIndex],
          arrival_airport: arrivalAirport,
          overnight: dayOffset > 0,
          connection_type: transferText ? 'connecting' : directText ? 'direct' : null,
          duration,
          displayed_price: displayedPriceOf(card),
        };
      };
      const observations = new Map();
      let identityConflict = false;
      const scanVisibleCards = () => {
        for (const card of document.querySelectorAll('.flight-item')) {
          if (performance.now() >= deadline) break;
          if (!visible(card)) continue;
          const item = parseCard(card);
          if (!item) continue;
          const identity = JSON.stringify([
            item.flight_number,
            item.departure_datetime,
            item.departure_airport,
            item.arrival_datetime,
            item.arrival_airport,
          ]);
          const providerId = clean(card.getAttribute('data-testid'));
          const key = providerId ? 'provider:' + providerId : 'identity:' + identity;
          const previous = observations.get(key);
          if (previous && previous.identity !== identity) {
            identityConflict = true;
            continue;
          }
          if (previous || observations.size < limit) observations.set(key, { identity, item });
        }
      };
      const changedScope = () => {
        const currentScope = readScope(false);
        return scopeMatches(currentScope) && sameScope(currentScope, observedScope) ? null : currentScope;
      };
      const interrupted = () => {
        if (hasCaptcha()) return { captcha: true };
        const driftedScope = changedScope();
        return driftedScope ? {
          scope_valid: false,
          scope_drift: true,
          observed_scope: driftedScope,
          page_reported_counts: pageReportedCounts,
          sort_label: sortLabel,
          items: [],
        } : null;
      };

      scanVisibleCards();
      if (identityConflict) return resolve({ identity_conflict: true });
      let scrollCount = 0;
      let roundsWithoutNewItems = 0;
      let stopReason = performance.now() >= deadline ? 'time_budget' : observations.size >= limit ? 'limit' : null;
      while (!stopReason) {
        const interruption = interrupted();
        if (interruption) return resolve(interruption);
        if (performance.now() >= deadline) {
          stopReason = 'time_budget';
          break;
        }
        if (scrollCount >= ${DISCOVERY_SCROLL_LIMIT}) {
          stopReason = 'scroll_limit';
          break;
        }

        window.scrollBy(0, Math.max(1, Math.floor(innerHeight * 0.8)));
        scrollCount += 1;
        const afterScrollInterruption = interrupted();
        if (afterScrollInterruption) return resolve(afterScrollInterruption);
        const sizeBeforeRound = observations.size;
        const roundDeadline = Math.min(deadline, performance.now() + 1000);
        scanVisibleCards();
        if (identityConflict) return resolve({ identity_conflict: true });
        const afterScanInterruption = interrupted();
        if (afterScanInterruption) return resolve(afterScanInterruption);
        while (observations.size < limit && performance.now() < roundDeadline) {
          const pendingInterruption = interrupted();
          if (pendingInterruption) return resolve(pendingInterruption);
          await sleep(Math.min(250, roundDeadline - performance.now()));
          const settledInterruption = interrupted();
          if (settledInterruption) return resolve(settledInterruption);
          scanVisibleCards();
          if (identityConflict) return resolve({ identity_conflict: true });
        }
        const foundNewItems = observations.size > sizeBeforeRound;
        roundsWithoutNewItems = foundNewItems ? 0 : roundsWithoutNewItems + 1;
        if (performance.now() >= deadline) stopReason = 'time_budget';
        else if (observations.size >= limit) stopReason = 'limit';
        else if (roundsWithoutNewItems >= 3) stopReason = 'plateau';
        else if (scrollCount >= ${DISCOVERY_SCROLL_LIMIT}) stopReason = 'scroll_limit';
      }

      const items = [...observations.values()].map(({ item }) => item).slice(0, limit);
      return resolve({
        scope_valid: true,
        observed_scope: observedScope,
        page_reported_counts: pageReportedCounts,
        sort_label: sortLabel,
        items,
        collection: {
          requested_limit: limit,
          returned_count: items.length,
          scroll_count: scrollCount,
          stop_reason: stopReason,
          duration_ms: Math.round(Math.max(0, performance.now() - startedAt)),
        },
      });
      };
      void collect().catch(() => resolve({ extraction_error: true }));
    })`;
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

function normalizeDisplayedPrice(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const amount = typeof value.amount === 'string' ? value.amount.trim() : '';
    if (!/^[1-9]\d{0,8}(?:\.\d{1,2})?$/.test(amount) ||
        value.currency_symbol !== '¥' || value.qualifier !== 'starting' ||
        value.tax_inclusion !== 'included' || value.passenger_basis !== 'unknown') {
        return null;
    }
    return {
        amount,
        currency_symbol: '¥',
        qualifier: 'starting',
        tax_inclusion: 'included',
        passenger_basis: 'unknown',
    };
}

function normalizeDiscoveryItem(item) {
    const airline = cleanString(item?.airline);
    const departureDatetime = cleanString(item?.departure_datetime);
    const departureAirport = cleanString(item?.departure_airport);
    const arrivalDatetime = cleanString(item?.arrival_datetime);
    const arrivalAirport = cleanString(item?.arrival_airport);
    if (!airline || !isValidObservedDatetime(departureDatetime) || !isCredibleAirport(departureAirport) ||
        !isValidObservedDatetime(arrivalDatetime) || !isCredibleAirport(arrivalAirport)) {
        throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
    }
    const connectionType = item?.connection_type;
    if (![null, 'direct', 'connecting'].includes(connectionType)) {
        throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
    }
    if (![null, true, false].includes(item?.overnight)) {
        throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
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
        displayed_price: normalizeDisplayedPrice(item?.displayed_price),
    };
}

cli({
    site: 'ctrip',
    name: 'flight-discover',
    access: 'read',
    description: '返回携程单程页有界滚动中实际可见的航班候选（可含展示起价，但不是报价或库存）',
    domain: 'flights.ctrip.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    defaultFormat: 'json',
    args: [
        { name: 'from', required: true, positional: true, help: 'Departure IATA code (e.g. BJS / PEK)' },
        { name: 'to', required: true, positional: true, help: 'Arrival IATA code (e.g. SHA / PVG)' },
        { name: 'date', required: true, help: 'Departure date (YYYY-MM-DD)' },
        { name: 'limit', default: DEFAULT_DISCOVERY_ITEMS, help: 'Number of visibly observed candidates (1-40)' },
    ],
    func: async (page, kwargs) => {
        const origin = parseIataCode('from', kwargs.from);
        const destination = parseIataCode('to', kwargs.to);
        if (origin === destination) {
            throw new ArgumentError(`--from and --to must differ (got ${origin})`);
        }
        const departureDate = parseIsoDate('date', kwargs.date);
        const limit = parseStrictIntegerRange('limit', kwargs.limit, DEFAULT_DISCOVERY_ITEMS, 1, MAX_DISCOVERY_ITEMS);
        const requestedScope = {
            origin,
            destination,
            departure_date: departureDate,
        };
        const searchUrl =
            `https://flights.ctrip.com/online/list/oneway-${origin.toLowerCase()}-${destination.toLowerCase()}` +
            `?depdate=${departureDate}&cabin=Y_S_C_F&adult=1&child=0&infant=0`;
        await page.goto(searchUrl);
        const raw = await page.evaluate(buildFlightDiscoveryExtractJs(requestedScope, limit));
        if (raw?.captcha === true) {
            throw new AuthRequiredError('flights.ctrip.com', 'Ctrip is asking for a captcha; complete it in your browser session and retry');
        }
        if (raw?.initial_timeout === true) {
            throw new TimeoutError(
                'Ctrip visible initial flight wait',
                DISCOVERY_WAIT_SECONDS,
                'No visible flight card appeared during the fixed initial readiness window; check the Ctrip browser session and retry.',
            );
        }
        if (raw?.identity_conflict === true) {
            throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
        }
        if (raw?.extraction_error === true) {
            throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
        }
        if (!raw || typeof raw !== 'object') {
            throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
        }
        if (raw.scope_valid !== true || !raw.observed_scope) {
            throw new CommandExecutionError(DISCOVERY_SCOPE_ERROR);
        }
        if (!Array.isArray(raw.items) || raw.items.length === 0) {
            throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
        }
        const scope = raw.observed_scope;
        if (scope.origin !== origin || scope.destination !== destination ||
            scope.departure_date !== departureDate || scope.trip_type !== 'one_way' ||
            scope.adults !== 1 || scope.children !== 0 || scope.infants !== 0 ||
            !cleanString(scope.cabin_filter_label) || scope.time_basis !== 'page_displayed_local_time') {
            throw new CommandExecutionError(DISCOVERY_SCOPE_ERROR);
        }
        const pageReportedCounts = raw.page_reported_counts;
        if (pageReportedCounts !== null && (typeof pageReportedCounts !== 'object' ||
            !Number.isSafeInteger(pageReportedCounts.total_results) || pageReportedCounts.total_results < 0 ||
            (pageReportedCounts.direct_results !== undefined &&
                (!Number.isSafeInteger(pageReportedCounts.direct_results) || pageReportedCounts.direct_results < 0)))) {
            throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
        }
        const sortLabel = cleanString(raw.sort_label);
        const collection = raw.collection;
        const stopReasons = ['limit', 'time_budget', 'scroll_limit', 'plateau'];
        if (!collection || typeof collection !== 'object' || collection.requested_limit !== limit ||
            raw.items.length > limit || collection.returned_count !== raw.items.length ||
            !Number.isSafeInteger(collection.scroll_count) || collection.scroll_count < 0 || collection.scroll_count > 12 ||
            !stopReasons.includes(collection.stop_reason) ||
            !Number.isSafeInteger(collection.duration_ms) || collection.duration_ms < 0 || collection.duration_ms > 60000) {
            throw new CommandExecutionError(DISCOVERY_OUTPUT_ERROR);
        }
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
            coverage: 'observed_bounded_results',
            collection: {
                requested_limit: collection.requested_limit,
                returned_count: collection.returned_count,
                scroll_count: collection.scroll_count,
                stop_reason: collection.stop_reason,
                duration_ms: collection.duration_ms,
            },
            page_reported_counts: normalizedCounts,
            sort_label: sortLabel,
            items: raw.items.slice(0, limit).map(normalizeDiscoveryItem),
        };
    },
});

export const __test__ = { buildFlightDiscoveryExtractJs };
