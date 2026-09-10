import { useTheme } from "../../styles/ThemeProvider";
import { themeNames } from "../../styles/theme";
import { Button } from "../../ui/Button";
import { CheckboxField } from "../../ui/CheckboxField";
import { Field } from "../../ui/Field";
import { Icon, iconNames } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Input } from "../../ui/Input";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { Select } from "../../ui/Select";
import { StatusBadge } from "../../ui/StatusBadge";
import { Switch } from "../../ui/Switch";

function BoardSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="sh-preview-board__section">
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  );
}

/**
 * DEV-only foundations board (/__preview/ui-foundations).
 * 9 个主题、基础控件、状态徽标与图标注册表的单一验收入口；
 * 不进入生产路由，也不承载业务数据。
 */
export function UiFoundationsPreview() {
  const { appearance, resolvedTheme, setAppearance } = useTheme();

  return (
    <PageFrame width="wide">
      <PageHeader
        description="共享基础层验收展板：主题语义角色、基础控件、状态与图标的单一来源。"
        title="UI foundations"
      />

      <BoardSection
        description={`当前选择：${appearance}；解析结果：${resolvedTheme}。切换立即生效并写入既有持久化键。`}
        title="主题"
      >
        <div aria-label="主题切换" className="sh-preview-board__themes" role="group">
          {themeNames.map((theme) => (
            <button
              aria-pressed={appearance === theme}
              className="sh-preview-board__theme"
              key={theme}
              onClick={() => setAppearance(theme)}
              type="button"
            >
              {theme}
            </button>
          ))}
        </div>
      </BoardSection>

      <BoardSection
        description="Field 统一标签、帮助、错误、必填与 aria 关联；控件高度遵循 40/32/44px。"
        title="表单控件"
      >
        <div className="sh-preview-board__form">
          <Field help="集中库的绝对路径。" label="文本输入">
            <Input name="preview-text" placeholder="例如 /Users/me/SkillHub" />
          </Field>
          <Field
            error="端点不能为空。"
            label="必填与错误"
            required
          >
            <Input aria-invalid name="preview-invalid" />
          </Field>
          <Field label="下拉选择">
            <Select defaultValue="copy" name="preview-select">
              <option value="copy">复制部署</option>
              <option value="link">符号链接</option>
            </Select>
          </Field>
          <CheckboxField
            defaultChecked
            description="点击整行文字即可切换。"
            label="复选框与文字共享点击区"
          />
          <Switch defaultChecked label="立即生效的开关" />
        </div>
      </BoardSection>

      <BoardSection
        description="加载中保留原动作文字，仅追加不重复朗读的加载标识。"
        title="按钮"
      >
        <div className="sh-preview-board__row">
          <Button>主操作</Button>
          <Button variant="secondary">次级</Button>
          <Button variant="ghost">幽灵</Button>
          <Button loading>
            正在保存
          </Button>
          <IconButton icon="delete" label="删除技能" />
          <IconButton icon="open-external" label="在外部打开" />
        </div>
      </BoardSection>

      <BoardSection
        description="状态徽标使用胶囊形，始终是图标或圆点加文字，不单靠颜色。"
        title="状态徽标"
      >
        <div className="sh-preview-board__row">
          <StatusBadge tone="success">成功</StatusBadge>
          <StatusBadge tone="warning">警告</StatusBadge>
          <StatusBadge tone="danger">失败</StatusBadge>
          <StatusBadge tone="info">信息</StatusBadge>
          <StatusBadge>中性</StatusBadge>
        </div>
      </BoardSection>

      <BoardSection
        description="本地功能图标注册表：装饰用途，始终 aria-hidden，含义由文字或按钮标签承载。"
        title="图标注册表"
      >
        <ul className="sh-preview-board__icons">
          {iconNames.map((name) => (
            <li key={name}>
              <Icon name={name} size={24} />
              <span>{name}</span>
            </li>
          ))}
        </ul>
      </BoardSection>
    </PageFrame>
  );
}
