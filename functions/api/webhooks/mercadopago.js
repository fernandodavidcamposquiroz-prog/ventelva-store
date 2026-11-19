import { handleWebhook, endpoint } from '../../../server/checkout.mjs';
export const onRequest = endpoint(handleWebhook);
