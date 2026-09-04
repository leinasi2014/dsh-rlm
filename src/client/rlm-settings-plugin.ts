/**
 * dsh-rlm browser client plugin. Applying it registers the `rlm.settings` locale
 * dictionaries and contributes the RlmSettingsCard into the official
 * `settings.plugin.item` slot keyed by the `rlm` settings namespace, so the
 * configurable-plugins tab pairs the card with the Host's `rlm` settings
 * section without either side knowing the namespace's meaning.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { RlmSettingsCard, type RlmSettingsFace } from './RlmSettingsCard.js'
import { RLM_SETTINGS_LOCALE_NS, RLM_SETTINGS_NAMESPACE, type RlmSettings } from './rlm-settings-model.js'
import { rlmSettingsEn, rlmSettingsZh, type RlmSettingsKey } from './rlm-settings-locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'rlm.settings': RlmSettingsKey
  }
}

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: ClientContext): void {
  if (ctx.get('slots') === undefined) throw new Error('dsh-rlm settings card requires the official Slots service')
  if (ctx.get('locale') === undefined) throw new Error('dsh-rlm settings card requires the official Locale service')
  if (ctx.get('settingsScope') === undefined) throw new Error('dsh-rlm settings card requires the official Settings scope service')
  ctx.effect(() => ctx.locale.register(RLM_SETTINGS_LOCALE_NS, { zh: rlmSettingsZh, en: rlmSettingsEn }), 'dsh-rlm settings dictionaries')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: RLM_SETTINGS_NAMESPACE,
    locale: RLM_SETTINGS_LOCALE_NS,
    inject: (): RlmSettingsFace => ({ scope: ctx.settingsScope.bind<RlmSettings>({ namespace: RLM_SETTINGS_NAMESPACE }) }),
  }, RlmSettingsCard))
}
