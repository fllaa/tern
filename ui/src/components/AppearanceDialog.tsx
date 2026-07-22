// Appearance settings: app theme, terminal colour scheme, terminal font.
//
// Changes apply live (so the choice is visible while making it) and persist on
// each change. The parent owns the record and the apply/persist side effects;
// this is just the controls.

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldControl, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import type { Appearance, AppTheme } from "../lib/appearance";
import { TERMINAL_SCHEMES } from "../terminal/theme";

const THEMES: Array<{ value: AppTheme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const FONT_MIN = 8;
const FONT_MAX = 32;

export function AppearanceDialog({
  value,
  onChange,
  onClose,
}: {
  value: Appearance;
  onChange: (next: Appearance) => void;
  onClose: () => void;
}) {
  const patch = (part: Partial<Appearance>) => onChange({ ...value, ...part });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field>
            <FieldLabel>Theme</FieldLabel>
            <div className="flex gap-1">
              {THEMES.map((t) => (
                <Button
                  key={t.value}
                  size="sm"
                  variant={value.theme === t.value ? "primary" : "secondary"}
                  onClick={() => patch({ theme: t.value })}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </Field>

          <Field>
            <FieldLabel>Terminal colours</FieldLabel>
            <div className="flex flex-wrap gap-1">
              {TERMINAL_SCHEMES.map((s) => (
                <Button
                  key={s.value}
                  size="sm"
                  variant={value.terminalTheme === s.value ? "primary" : "secondary"}
                  onClick={() => patch({ terminalTheme: s.value })}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </Field>

          <div className="flex gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel>Terminal font</FieldLabel>
              <FieldControl
                render={
                  <Input
                    placeholder="Theme default"
                    value={value.fontFamily}
                    onChange={(e) => patch({ fontFamily: e.target.value })}
                  />
                }
              />
            </Field>
            <Field className="w-24">
              <FieldLabel>Size</FieldLabel>
              <FieldControl
                render={
                  <Input
                    type="number"
                    min={FONT_MIN}
                    max={FONT_MAX}
                    value={value.fontSize}
                    onChange={(e) => {
                      // Clamp so a fat-fingered 200 cannot make the terminal
                      // unusable; an empty field is left for the user to finish.
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n > 0) {
                        patch({ fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, n)) });
                      }
                    }}
                  />
                }
              />
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
