import { Studio } from "@/components/Studio";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Studio projectId={id} />;
}
