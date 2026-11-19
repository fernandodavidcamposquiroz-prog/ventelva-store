import { handleOrders, endpoint } from '../../server/checkout.mjs';
export const onRequest = endpoint(handleOrders);
