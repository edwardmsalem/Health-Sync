import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
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
import { runSync } from "./src/sync/runSync.ts";

WebBrowser.maybeCompleteAuthSession();

export default function App() {
  const [fitbitConnected, setFitbitConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [request, response, promptAsync] = useFitbitAuthRequest();

  useEffect(() => {
    isConnected().then(setFitbitConnected);
  }, []);

  useEffect(() => {
    if (response?.type === "success" && request && response.params.code) {
      exchangeCode(request, response.params.code)
        .then(() => setFitbitConnected(true))
        .catch((e) => setError(String(e)));
    }
  }, [response, request]);

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
          Apple Health ⇄ Fitbit, without double counting
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>1 · Connect Fitbit</Text>
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
          <Text style={styles.cardTitle}>2 · Sync</Text>
          <Text style={styles.hint}>
            Reads the last 7 days from Apple Health and Fitbit, removes
            overlap (both devices worn), and fills each side's gaps.
          </Text>
          <Pressable
            style={[styles.button, (!fitbitConnected || syncing) && styles.buttonDisabled]}
            disabled={!fitbitConnected || syncing}
            onPress={onSync}
          >
            {syncing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sync now</Text>
            )}
          </Pressable>
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
            {report.plans.map((plan) => (
              <Row
                key={plan.platform}
                label={`Written to ${plan.platform === "apple" ? "Apple Health" : "Fitbit"}`}
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
  rowLabel: { fontSize: 14, color: "#444", flexShrink: 1 },
  rowValue: { fontSize: 14, fontWeight: "600" },
});
