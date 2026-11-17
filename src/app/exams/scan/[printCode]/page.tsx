import { ExamScanLanding } from "@/components/exam/exam-scan-landing";

interface ExamScanPageProps {
    params: Promise<{ printCode: string }>;
    searchParams: Promise<{ v?: string | string[] }>;
}

export default async function ExamScanPage({ params, searchParams }: ExamScanPageProps) {
    const [{ printCode }, query] = await Promise.all([params, searchParams]);
    const requestedVersion = typeof query.v === "string" ? query.v : null;
    return <ExamScanLanding printCode={printCode} requestedVersion={requestedVersion} />;
}
