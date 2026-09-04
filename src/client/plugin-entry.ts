/**
 * dsh-rlm client plugin entry. Re-exports the settings card and the plugin's
 * `apply`/`inject` so the Host client bundle (`dsh.client` manifest) loads the
 * card into the settings UI under the `rlm` namespace.
 */
export { RlmSettingsCard, type RlmSettingsCardProps, type RlmSettingsFace } from './RlmSettingsCard.js'
export * from './rlm-settings-model.js'
export * from './rlm-settings-locales.js'
export { apply, inject } from './rlm-settings-plugin.js'
