import { imageMsg, listMsg, textMsg, ctaUrlMsg } from '../channels/whatsapp/builders.js';
import { errInfo } from './log.js';
import { sendAndLog } from '../channels/whatsapp/sender.js';
import type { Customer } from '../customers/customer-repo.js';
import type { AppDeps } from '../deps.js';
import { getTenantSettings } from '../tenants/settings-repo.js';
import type { TenantConfig } from '../tenants/types.js';

export const BTN_ORDER = 'menu:order';
export const BTN_SUBSCRIBE = 'menu:subscribe';
export const BTN_MY_ORDERS = 'menu:my_orders';
export const BTN_HELP = 'menu:help';

/** Optional welcome image, then the list menu (reply buttons max 3; list headers are text-only). */
export async function sendMenu(deps: AppDeps, tenant: TenantConfig, customer: Customer): Promise<void> {
  const { copy } = tenant;
  const settings = await getTenantSettings(deps.db, tenant.id);
  const welcome = copy.welcome(customer.profileName);
  // The image is decoration: a bad vendor URL or Graph rejection must never take the menu down.
  let imageSent = false;
  if (settings.welcomeImageUrl) {
    try {
      await sendAndLog(deps, tenant, customer, imageMsg({ link: settings.welcomeImageUrl, caption: welcome }), welcome);
      imageSent = true;
    } catch (err) {
      deps.log.warn({ tenantId: tenant.id, err: errInfo(err) }, 'welcome image failed; sending menu without it');
    }
  }
  const body = imageSent ? copy.menuPrompt() : `${welcome}\n\n${copy.menuPrompt()}`;
  const rows = copy.menuRows();
  await sendAndLog(
    deps,
    tenant,
    customer,
    listMsg({
      body,
      buttonText: 'Menu',
      sections: [
        {
          rows: [
            { id: BTN_ORDER, title: 'Order Eggs', description: rows.order },
            { id: BTN_SUBSCRIBE, title: 'Subscribe', description: rows.subscribe },
            { id: BTN_MY_ORDERS, title: 'My Orders', description: rows.myOrders },
            { id: BTN_HELP, title: 'Help', description: rows.help },
          ],
        },
      ],
    }),
    body,
  );
}

export async function sendHelp(deps: AppDeps, tenant: TenantConfig, customer: Customer): Promise<void> {
  const settings = await getTenantSettings(deps.db, tenant.id);
  const body = tenant.copy.help();
  const digits = (settings.supportPhone ?? '').replace(/\D/g, '');
  if (digits.length >= 10) {
    await sendAndLog(
      deps,
      tenant,
      customer,
      ctaUrlMsg({ body, buttonText: 'Call the farm', url: `tel:+${digits}` }),
      body,
    );
    return;
  }
  deps.log.warn({ tenantId: tenant.id }, 'support phone not set; sending plain help text');
  await sendAndLog(deps, tenant, customer, textMsg(body), body);
}
