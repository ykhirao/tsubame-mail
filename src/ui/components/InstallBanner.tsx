import { useEffect, useState } from "react";
import { Button } from "@/ui/components/Button";
import { IosInstallSheet } from "@/ui/components/IosInstallSheet";
import {
	dismissInstallBanner,
	hasInstallPrompt,
	isIos,
	promptInstall,
	shouldShowInstallBanner,
} from "@/ui/lib/pwa";

export function InstallBanner() {
	const [visible, setVisible] = useState(false);
	const [iosOpen, setIosOpen] = useState(false);

	useEffect(() => {
		setVisible(shouldShowInstallBanner());
	}, []);

	if (!visible) return null;

	const add = async () => {
		// iOS は beforeinstallprompt が無く、共有メニューから手で追加する。
		if (isIos() || !hasInstallPrompt()) {
			setIosOpen(true);
			return;
		}
		if ((await promptInstall()) === "accepted") setVisible(false);
	};

	const notNow = () => {
		dismissInstallBanner();
		setVisible(false);
	};

	return (
		<>
			<div className="card p-4">
				<p className="text-sm text-[var(--text)]">
					ホーム画面に追加すると、新着をプッシュ通知で受け取れます
				</p>
				<div className="mt-3 flex items-center gap-2">
					<Button onClick={() => void add()}>追加する</Button>
					<Button variant="ghost" onClick={notNow}>
						今はしない
					</Button>
				</div>
			</div>
			<IosInstallSheet open={iosOpen} onClose={() => setIosOpen(false)} />
		</>
	);
}
