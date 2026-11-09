"use client";

import { useParams } from 'next/navigation';

import { ExamAttemptReview } from '@/components/exam-attempt/exam-attempt-review';

export default function ExamAttemptReviewPage() {
    const { id } = useParams<{ id: string }>();
    return <ExamAttemptReview attemptId={id} />;
}
