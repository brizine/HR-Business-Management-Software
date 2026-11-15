import { MyDocuments } from "@/components/my-documents";
import { Screen } from "@/components/ui";
import { useApi } from "@/lib/hooks";

/** Your documents and the company's: tap to open; sign the ones waiting for you. */
export default function Documents() {
  const docs = useApi<any[]>("/documents?mine=true");
  return (
    <Screen refreshing={docs.loading} onRefresh={docs.reload}>
      <MyDocuments docs={docs.data} onChange={docs.reload} page />
    </Screen>
  );
}
