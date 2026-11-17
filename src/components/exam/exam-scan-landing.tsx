"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";

interface ExamPrintCodeResolution {
    paperId: string;
    title: string;
    printCode: string;
    currentPrintVersion: string;
    versionMatches: boolean;
}

interface ExamScanLandingProps {
    printCode: string;
    requestedVersion: string | null;
}

type ResolutionState =
    | { requestKey: string; status: "loading" }
    | { requestKey: string; status: "resolved"; value: ExamPrintCodeResolution }
    | { requestKey: string; status: "failed" };

export function ExamScanLanding({ printCode, requestedVersion }: ExamScanLandingProps) {
    const router = useRouter();
    const { t } = useLanguage();
    const requestKey = `${printCode}:${requestedVersion ?? ""}`;
    const [state, setState] = useState<ResolutionState>({ requestKey, status: "loading" });

    useEffect(() => {
        let active = true;
        apiClient.get<ExamPrintCodeResolution>(
            `/api/exams/print-code/${encodeURIComponent(printCode)}`,
            requestedVersion ? { params: { v: requestedVersion } } : undefined,
        ).then((value) => {
            if (!active) return;
            if (value.versionMatches) {
                router.replace(`/exams/${value.paperId}/attempts/new`);
                return;
            }
            setState({ requestKey, status: "resolved", value });
        }).catch(() => {
            if (active) setState({ requestKey, status: "failed" });
        });
        return () => { active = false; };
    }, [printCode, requestedVersion, requestKey, router]);

    if (state.requestKey !== requestKey || state.status === "loading") {
        return <PageLoading label={t.exam.scanChecking} />;
    }

    if (state.status === "failed") {
        return (
            <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-8">
                <Card role="alert" className="w-full">
                    <CardHeader>
                        <CardTitle>{t.exam.scanNotFoundTitle}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">{t.exam.scanNotFoundDescription}</p>
                        <Button asChild className="w-full sm:w-auto">
                            <Link href="/exams">{t.exam.scanBackToExams}</Link>
                        </Button>
                    </CardContent>
                </Card>
            </main>
        );
    }

    const resolution = state.value;

    return (
        <main className="mx-auto min-h-screen max-w-lg px-4 py-6 sm:py-10">
            <div className="space-y-6">
                <PageHeader
                    title={t.exam.scanMismatchTitle}
                    description={resolution.title}
                    backHref="/exams"
                />
                <Card className="border-amber-300 bg-amber-50/70">
                    <CardContent className="space-y-4 pt-6">
                        <div className="flex items-start gap-3 text-amber-900">
                            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                            <p className="text-sm">{t.exam.scanMismatchDescription}</p>
                        </div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                            <dt className="text-muted-foreground">{t.exam.printCodeLabel}</dt>
                            <dd className="break-all font-mono font-semibold">{resolution.printCode}</dd>
                            <dt className="text-muted-foreground">{t.exam.printVersionLabel}</dt>
                            <dd className="break-all font-mono font-semibold">{resolution.currentPrintVersion}</dd>
                        </dl>
                        <Button
                            type="button"
                            className="w-full"
                            onClick={() => router.push(`/exams/${resolution.paperId}/attempts/new`)}
                        >
                            {t.exam.scanContinue}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </main>
    );
}
