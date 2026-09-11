import { useEffect, useRef, useState } from "react";

export interface MultiSelectMenuProps {
  label: string;
  onChange: (values: string[]) => void;
  options: Array<{ label: string; value: string }>;
  selected: string[];
  summary: string;
}

/**
 * 统一多选控件：折叠触发按钮 + 展开的原生 checkbox 菜单。
 * 受控组件——选中集合完全由 `selected` 驱动，逐项切换通过 `onChange`
 * 上抛新数组；菜单语义（role="menu"/"menuitemcheckbox"）与
 * `.sh-filter-dropdown*` 样式契约保持与原 SkillFilters 实现一致，
 * 供技能库筛选等场景复用。
 */
export function MultiSelectMenu({
  label,
  onChange,
  options,
  selected,
  summary,
}: MultiSelectMenuProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);
  const toggle = (value: string, checked: boolean) => {
    onChange(checked ? [...selected, value] : selected.filter((item) => item !== value));
  };

  return (
    <div className="sh-filter-dropdown" ref={dropdownRef}>
      <span className="sh-filter-dropdown__label">{label}</span>
      <button
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        className="sh-filter-dropdown__trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{summary}</span>
      </button>
      {open ? (
        <div aria-label={label} className="sh-filter-dropdown__menu" role="menu">
          {options.map((option) => (
            <label key={option.value}>
              <input
                aria-checked={selected.includes(option.value)}
                aria-label={option.label}
                checked={selected.includes(option.value)}
                onChange={(event) => toggle(option.value, event.currentTarget.checked)}
                role="menuitemcheckbox"
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
