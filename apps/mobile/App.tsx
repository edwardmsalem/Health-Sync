import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import type { SyncReport } from "health-sync";
import {
  disconnect,
  exchangeCode,
  isConnected,
  useFitbitAuthRequest,
} from "./src/fitbit/auth.ts";
import {
  getNightscoutConfig,
  setNightscoutConfig,
} from "./src/nightscout/config.ts";
import {
  cancelBackfill,
  getBackfillState,
  progressOf,
  runBackfill,
  startBackfill,
  type BackfillProgress,
} from "./src/sync/backfill.ts";
import { enableBackgroundSync } from "./src/sync/background.ts";
import { runSync } from "./src/sync/runSync.ts";
import { AsyncStorageKV } from "./src/storage/asyncStorageKV.ts";

WebBrowser.maybeCompleteAuthSession();

export default function App() {
  const [fitbitConnected, setFitbitConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [request, response, promptAsync] = useFitbitAuthRequest();
  const [nsUrl, setNsUrl] = useState("");
  const [nsToken, setNsToken] = useState("");
  const [nsConfigured, setNsConfigured] = useState(false);
  const [historyDays, setHistoryDays] = useState(60);
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [historyNote, setHistoryNote] = useState<string | null>(null);

  useEffect(() => {
    getBackfillState(new AsyncStorageKV()).then((s) =>
      setBackfill(s ? progressOf(s) : null),
    );
    isConnected().then(setFitbitConnected);
    getNightscoutConfig().then((cfg) => {
      if (cfg) {
        setNsUrl(cfg.url);
        setNsToken(cfg.token);
        setNsConfigured(true);
      }
    });
  }, []);

  const anySourceConnected = fitbitConnected || nsConfigured;

  // Once any source is connected, ask iOS to sync periodically in background.
  useEffect(() => {
    if (anySourceConnected) {
      enableBackgroundSync().catch(() => {
        // Background refresh disabled in Settings — manual sync still works.
      });
    }
  }, [anySourceConnected]);

  useEffect(() => {
    if (response?.type === "success" && request && response.params.code) {
      exchangeCode(request, response.params.code)
        .then(() => setFitbitConnected(true))
        .catch((e) => setError(String(e)));
    }
  }, [response, request]);

  const onImportHistory = useCallback(async () => {
    setImporting(true);
    setError(null);
    setHistoryNote(null);
    try {
      const kv = new AsyncStorageKV();
      if (!(await getBackfillState(kv))) {
        await startBackfill(historyDays, Date.now(), kv);
      }
      const result = await runBackfill({
        kv,
        maxChunks: 5,
        onChunk: setBackfill,
      });
      setBackfill(result.progress);
      setHistoryNote(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [historyDays]);

  const onCancelHistory = useCallback(async () => {
    await cancelBackfill(new AsyncStorageKV());
    setBackfill(null);
    setHistoryNote(null);
  }, []);

  const onSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await runSync();
      setReport(result.report);
      setSkipped(result.fitbitSkippedWrites);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Health Sync</Text>
        <Text style={styles.subtitle}>
          Everything merged into Apple Health, without double counting
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>1 · Fitbit (optional)</Text>
          {fitbitConnected ? (
            <>
              <Text style={styles.ok}>Connected ✓</Text>
              <Pressable
                onPress={() => disconnect().then(() => setFitbitConnected(false))}
              >
                <Text style={styles.link}>Disconnect</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={styles.button}
              disabled={!request}
              onPress={() => promptAsync()}
            >
              <Text style={styles.buttonText}>Sign in with Fitbit</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>2 · Nightscout (AAPS)</Text>
          <Text style={styles.hint}>
            Pulls CGM glucose, insulin, and carbs into Apple Health.
            Read-only — nothing is ever written to Nightscout.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="https://your-nightscout-site.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={nsUrl}
            onChangeText={setNsUrl}
          />
          <TextInput
            style={styles.input}
            placeholder="Access token (optional for open sites)"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={nsToken}
            onChangeText={setNsToken}
          />
          {nsConfigured ? (
            <View style={styles.rowBetween}>
              <Text style={styles.ok}>Configured ✓</Text>
              <Pressable
                onPress={() =>
                  setNightscoutConfig(null).then(() => {
                    setNsUrl("");
                    setNsToken("");
                    setNsConfigured(false);
                  })
                }
              >
                <Text style={styles.link}>Remove</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.button, !nsUrl.startsWith("http") && styles.buttonDisabled]}
              disabled={!nsUrl.startsWith("http")}
              onPress={() =>
                setNightscoutConfig({ url: nsUrl.trim(), token: nsToken.trim() })
                  .then(() => setNsConfigured(true))
                  .catch((e) => setError(String(e)))
              }
            >
              <Text style={styles.buttonText}>Save Nightscout</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>3 · Sync</Text>
          <Text style={styles.hint}>
            Reads the last 7 days from Apple Health and Fitbit, removes
            overlap (both devices worn), and fills each side's gaps. Once
            connected, iOS also runs this automatically a few times a day.
          </Text>
          <Pressable
            style={[styles.button, (!anySourceConnected || syncing) && styles.buttonDisabled]}
            disabled={!anySourceConnected || syncing}
            onPress={onSync}
          >
            {syncing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sync now</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>4 · Import history</Text>
          <Text style={styles.hint}>
            Pulls older Fitbit data into Apple Health, deduped the same way as
            live data. Fitbit limits how fast history can be read, so this runs
            in batches — it picks up where it left off, including on its own in
            the background.
          </Text>

          <View style={styles.chipRow}>
            {[30, 60, 90].map((d) => (
              <Pressable
                key={d}
                style={[styles.chip, historyDays === d && styles.chipActive]}
                disabled={backfill !== null || importing}
                onPress={() => setHistoryDays(d)}
              >
                <Text style={[styles.chipText, historyDays === d && styles.chipTextActive]}>
                  {d} days
                </Text>
              </Pressable>
            ))}
          </View>

          {backfill && (
            <>
              <View style={styles.progressTrack}>
                <View
                  style={[styles.progressFill, { width: `${Math.round(backfill.fraction * 100)}%` }]}
                />
              </View>
              <Text style={styles.hint}>
                {backfill.daysRemaining} of {backfill.daysTotal} days left
              </Text>
            </>
          )}
          {historyNote && <Text style={styles.hint}>{historyNote}</Text>}

          <Pressable
            style={[styles.button, (!fitbitConnected || importing) && styles.buttonDisabled]}
            disabled={!fitbitConnected || importing}
            onPress={onImportHistory}
          >
            {importing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>
                {backfill ? "Continue import" : `Import last ${historyDays} days`}
              </Text>
            )}
          </Pressable>
          {backfill && !importing && (
            <Pressable onPress={onCancelHistory}>
              <Text style={styles.link}>Cancel import</Text>
            </Pressable>
          )}
          {!fitbitConnected && (
            <Text style={styles.hint}>Connect Fitbit above to import its history.</Text>
          )}
        </View>

        {error && (
          <View style={[styles.card, styles.errorCard]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {report && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Last sync</Text>
            <Row label="Double-counted steps removed" value={String(report.stepsDoubleCountRemoved)} />
            <Row
              label="Duplicate sleep removed"
              value={`${(report.sleepDoubleCountRemovedMs / 3_600_000).toFixed(1)} h`}
            />
            <Row
              label="Duplicate readings suppressed"
              value={String(report.pointDuplicatesRemoved)}
            />
            {report.plans
              .filter((plan) => plan.platform !== "nightscout")
              .map((plan) => (
                <Row
                  key={plan.platform}
                  label={`Written to ${
                    { apple: "Apple Health", google: "Fitbit", garmin: "Garmin" }[
                      plan.platform as "apple" | "google" | "garmin"
                    ] ?? plan.platform
                  }`}
                  value={`${plan.writes.length} records`}
                />
              ))}
            {skipped > 0 && (
              <Text style={styles.hint}>
                {skipped} record(s) have no Fitbit write API (raw steps/heart
                rate) and stay Apple-side only.
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f5f7" },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 32, fontWeight: "700" },
  subtitle: { fontSize: 15, color: "#666", marginBottom: 8 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  cardTitle: { fontSize: 17, fontWeight: "600" },
  hint: { fontSize: 13, color: "#666", lineHeight: 18 },
  button: {
    backgroundColor: "#007aff",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  ok: { color: "#34c759", fontWeight: "600" },
  link: { color: "#007aff" },
  errorCard: { backgroundColor: "#fff2f2" },
  errorText: { color: "#c00", fontSize: 13 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 14, color: "#444", flexShrink: 1 },
  rowValue: { fontSize: 14, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  chipRow: { flexDirection: "row", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#eef0f3",
  },
  chipActive: { backgroundColor: "#007aff" },
  chipText: { fontSize: 14, color: "#444", fontWeight: "500" },
  chipTextActive: { color: "#fff" },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#e6e8eb",
    overflow: "hidden",
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: "#34c759" },
});
