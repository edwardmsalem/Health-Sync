import { registerRootComponent } from "expo";
import "./src/sync/background.ts"; // define the background task at launch
import { startHealthObservers } from "./src/sync/observers.ts";
import App from "./App.tsx";

registerRootComponent(App);

// Wake on new HealthKit data so sync ticks through the day.
void startHealthObservers();
