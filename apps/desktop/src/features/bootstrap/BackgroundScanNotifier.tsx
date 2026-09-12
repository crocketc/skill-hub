import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import {
  getBackgroundScanState,
  markBackgroundScanReported,
  subscribeBackgroundScan,
  type NotifyFunction,
} from "./backgroundScan";

/** Route that hosts the local batch-import entry (existing discovery route). */
const LOCAL_IMPORT_ROUTE = "/discovery/local";
/** Route that hosts rediscovery for an initialized library (existing route). */
const REDISCOVERY_ROUTE = "/initialize";

/**
 * Bridge between the handed-off initialization scan and the global
 * notification service. The shell mounts this component once and passes the
 * notification service's `notify` (from `useAppNotifications()`); keeping it
 * prop-injected means the wizard feature never depends on shell internals.
 */
export function BackgroundScanNotifier({ notify }: { notify: NotifyFunction }) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeBackgroundScan, getBackgroundScanState);

  useEffect(() => {
    if (state.reported) {
      return;
    }
    if (state.status === "completed") {
      markBackgroundScanReported();
      notify({
        tone: "success",
        title: t("onboarding.backgroundScanCompleteTitle"),
        detail: t("onboarding.backgroundScanCompleteDetail", {
          count: state.result?.discovered.length ?? 0,
        }),
        action: { label: t("onboarding.summary.openImport"), to: LOCAL_IMPORT_ROUTE },
      });
      return;
    }
    if (state.status === "failed") {
      markBackgroundScanReported();
      notify({
        tone: "warning",
        title: t("onboarding.backgroundScanFailedTitle"),
        detail: describeNativeError(
          state.error,
          (key, options) => String(t(key as never, options as never)),
          "onboarding.scanFailedWithoutCode",
        ),
        action: { label: t("actions.retry"), to: REDISCOVERY_ROUTE },
      });
    }
  }, [state, notify, t]);

  return null;
}
