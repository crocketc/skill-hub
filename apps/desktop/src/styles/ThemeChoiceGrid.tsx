import { useTranslation } from "react-i18next";
import { themeNames, themePalettes, type ThemeName } from "./theme";

interface ThemeChoiceGridProps {
  onChange: (theme: ThemeName) => void;
  value: ThemeName;
}

export function ThemeChoiceGrid({ onChange, value }: ThemeChoiceGridProps) {
  const { t } = useTranslation();
  return (
    <div aria-label={t("theme.choiceLabel")} className="sh-theme-choice-grid" role="group">
      {themeNames.map((theme) => (
        <button
          aria-pressed={value === theme}
          className="sh-theme-choice"
          key={theme}
          onClick={() => onChange(theme)}
          type="button"
        >
          <span aria-hidden="true" aria-label={t("theme.palettePreview")} className="sh-theme-choice__palette">
            {themePalettes[theme].map((color) => <i key={color} style={{ backgroundColor: color }} />)}
          </span>
          <span>{t(`theme.choices.${theme}`)}</span>
        </button>
      ))}
    </div>
  );
}
