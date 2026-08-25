export const VERSION = "0.84.2";

export class InteractiveMode {
	constructor(version = "0.84.2") {
		this.version = version;
	}

	async init() {}

	mountInteractiveTui(tui, components) {
		for (const component of components) tui.addChild(component);
		if (tui.viewport) tui.setLayoutRoot(this.fullscreenLayoutRoot);
	}

	switchTuiMode() {}
}
