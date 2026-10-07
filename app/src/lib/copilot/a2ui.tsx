import {
  basicCatalog,
  Catalog,
  type ReactComponentImplementation,
} from "@copilotkit/a2ui-renderer";
import type { CopilotKitProviderProps } from "@copilotkit/react-core/v2";

/**
 * Keep the SDK's schemas, data bindings and action handlers. The wrapper only supplies a stable
 * styling hook: the 1.70.1 basic catalog uses inline styles and does not consume the theme prop.
 * These are declarative primitives, not the separately granted OpenBot gallery/custom components.
 */
function branded(
  component: ReactComponentImplementation,
): ReactComponentImplementation {
  const Render = component.render;
  return {
    ...component,
    render: (props) => (
      <div data-openbot-a2ui={component.name} style={{ display: "contents" }}>
        <Render {...props} />
      </div>
    ),
  };
}

export const OPENBOT_A2UI_CATALOG = new Catalog(
  basicCatalog.id,
  Array.from(basicCatalog.components.values(), branded),
  Array.from(basicCatalog.functions.values()),
  basicCatalog.themeSchema,
);

const A2UI_OPTIONS = {
  catalog: OPENBOT_A2UI_CATALOG,
  /*
   * The basic catalog schema is large and CopilotKit otherwise serializes it, plus its generation
   * and design guides, into agent context on every run. The renderer and A2UI middleware already
   * know the public basic catalog, so repeating those schemas makes ordinary browser/file turns pay
   * for UI instructions they never use. Keep the catalog for rendering and capability discovery,
   * but omit the full schema payload from model context.
   */
  includeSchema: false,
} satisfies NonNullable<CopilotKitProviderProps["a2ui"]>;

/** Prop presence activates the SDK, so an unresolved or disabled capability must omit it. */
export function a2uiProviderOptions(enabled: boolean | undefined) {
  return enabled ? { a2ui: A2UI_OPTIONS } : {};
}
