import { useEffect, useRef, useState } from "react";
import { Camera, Flashlight, FlashlightOff, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type ScannerControls = {
  stop: () => void;
  switchTorch?: (on: boolean) => Promise<void> | void;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function beep() {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    window.setTimeout(() => {
      osc.stop();
      void ctx.close();
    }, 90);
  } catch {
    // Optional feedback only.
  }
}

export function BarcodeScannerSheet({
  open,
  onClose,
  onDetected,
}: {
  open: boolean;
  onClose: () => void;
  onDetected: (barcode: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const completedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [scanKey, setScanKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    completedRef.current = false;
    setLoading(true);
    setError(null);
    setScanned(null);
    setTorchOn(false);
    setTorchSupported(false);

    async function start() {
      try {
        if (!videoRef.current) return;
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          },
          videoRef.current,
          (result) => {
            const code = result?.getText()?.trim();
            if (!code || completedRef.current) return;
            completedRef.current = true;
            setScanned(code);
            try {
              navigator.vibrate?.(80);
            } catch {
              // Optional feedback only.
            }
            beep();
            window.setTimeout(() => {
              controlsRef.current?.stop();
              onDetected(code);
            }, 450);
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setTorchSupported(typeof controls.switchTorch === "function");
      } catch (e) {
        setError(
          e instanceof Error && e.name === "NotAllowedError"
            ? "لم يتم السماح باستخدام الكاميرا."
            : "تعذر تشغيل ماسح الباركود على هذا الجهاز.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void start();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [open, scanKey, onDetected]);

  async function toggleTorch() {
    if (!controlsRef.current?.switchTorch) return;
    const next = !torchOn;
    try {
      await controlsRef.current.switchTorch(next);
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }

  function rescan() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanKey((x) => x + 1);
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="bottom" className="max-h-[95dvh] p-0 overflow-hidden">
        <SheetHeader className="p-4 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="text-base">مسح الباركود</SheetTitle>
            <Button type="button" variant="ghost" size="icon" onClick={onClose}>
              <X className="size-5" />
            </Button>
          </div>
        </SheetHeader>
        <div className="p-4 space-y-3">
          <div className="relative overflow-hidden rounded-2xl bg-black aspect-[3/4] max-h-[70dvh]">
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
            <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-28 rounded-xl border-2 border-primary shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
            {loading && (
              <div className="absolute inset-0 grid place-items-center bg-black/50 text-white">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  جاري فتح الكاميرا...
                </div>
              </div>
            )}
            {error && (
              <div className="absolute inset-0 grid place-items-center bg-black/70 p-5 text-center text-sm text-white">
                {error}
              </div>
            )}
          </div>

          {scanned ? (
            <div className="rounded-xl border border-success/40 bg-success/10 p-3 text-center">
              <div className="text-xs text-muted-foreground">تم مسح الباركود</div>
              <div className="font-bold tabular-nums" dir="ltr">{scanned}</div>
            </div>
          ) : (
            <div className="text-center text-xs text-muted-foreground">
              وجّه الكاميرا نحو الباركود حتى يظهر داخل الإطار.
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={rescan}>
              <RotateCcw className="size-4 ms-2" />
              إعادة المسح
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={!torchSupported}
              onClick={toggleTorch}
            >
              {torchOn ? <FlashlightOff className="size-4 ms-2" /> : <Flashlight className="size-4 ms-2" />}
              الفلاش
            </Button>
          </div>
          <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Camera className="size-3" />
            يدعم EAN-13 و EAN-8 و UPC و Code-128 حسب دعم الجهاز.
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
