import { cli } from '@jackwener/opencli/registry';
import { detailDefinition } from './tweet-detail-command.js';
// Backend serializes persistent readers by browser profile and site.
cli({ ...detailDefinition, name: 'poster-detail', siteSession: 'persistent',
    description: 'Fetch poster data using a retained X page; run through Backend for serialized page ownership',
});
