import { useSetDefaultModel, useSettings } from '../api'
import { Field, Select } from '../components/ui/form'
import { Card, PageHeader } from '../components/ui/layout'
import { ErrorBox, Loading } from '../components/ui/states'
import { usePageTitle } from '../title'

const FROM_CONFIG = ''

/** What a human sets for the whole factory. Per-task choices live on the task. */
export function SettingsPage() {
  usePageTitle('Settings')
  const settings = useSettings()
  const set = useSetDefaultModel()
  const s = settings.data
  return (
    <>
      <PageHeader
        title="Settings"
        description="Apply to every task from its next run. A task can have a model of its own; choose it on the task."
      />
      {settings.error ? <ErrorBox error={settings.error} /> : null}
      {!s ? (
        settings.error ? null : (
          <Loading what="settings" />
        )
      ) : (
        <Card className="max-w-xl">
          <div className="space-y-3 px-5 py-4">
            <Field
              label="Default model"
              hint={
                s.models.length
                  ? 'Tasks without a model of their own run on this one. Runs already finished keep showing the model they used.'
                  : 'No models on offer: list them under factory.models in tiller.yaml.'
              }
            >
              <Select
                value={s.default_model ?? FROM_CONFIG}
                disabled={set.isPending || !s.models.length}
                onChange={(e) => set.mutate(e.target.value === FROM_CONFIG ? null : e.target.value)}
              >
                <option value={FROM_CONFIG}>Each task's agent config decides</option>
                {s.models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
                {/* a default that is no longer on offer: shown, so it can be seen and changed */}
                {s.default_model && !s.models.includes(s.default_model) ? (
                  <option value={s.default_model}>{s.default_model} (no longer offered)</option>
                ) : null}
              </Select>
            </Field>
            {set.error ? <ErrorBox error={set.error} /> : null}
            <p className="text-fg-subtle text-xs leading-relaxed">
              The model gateway forwards only the model a run was started with and stops the run at
              the budget of its agent config. Offered models and prices: tiller.yaml.
            </p>
          </div>
        </Card>
      )}
    </>
  )
}
