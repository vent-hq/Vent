"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Copy, Plus, Trash2, Key, Check } from "lucide-react";
import {
  fetchAccessTokens,
  createAccessToken,
  revokeAccessToken,
  type AccessToken,
} from "@/lib/api";

export default function AccessTokensPage() {
  const [keys, setKeys] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const data = await fetchAccessTokens();
      setKeys(data);
    } catch {
      // silently fail — page still usable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const data = await createAccessToken(newKeyName || "default");
      setCreatedKey(data.refresh_token);
      loadKeys();
    } catch {
      // TODO: show error
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (createdKey) {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setCreatedKey(null);
    setNewKeyName("");
    setCopied(false);
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeAccessToken(id);
      loadKeys();
    } catch {
      // TODO: show error
    }
  };

  const activeKeys = keys.filter((k) => k.active);
  const revokedKeys = keys.filter((k) => !k.active);

  return (
    <div>
      <div className="h-16 flex items-center justify-between">
        <div>
          <h1 className="text-[1.125rem] leading-none font-medium tracking-[-0.01em]">
            API Keys
          </h1>
          <p className="text-[14px] text-muted-foreground mt-2">
            Revoking a key stops renewal. Existing access can last up to 15 minutes.
          </p>
        </div>
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            if (!open) handleCloseCreate();
            else setCreateOpen(true);
          }}
        >
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Create Key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {createdKey ? "API Key Created" : "Create API Key"}
              </DialogTitle>
            </DialogHeader>
            {createdKey ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Copy this API key now. The CLI uses it to renew access automatically. It will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 p-3 bg-muted rounded-md text-sm font-mono break-all select-all">
                    {createdKey}
                  </code>
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">
                    Usage:
                  </p>
                  <code className="text-xs">
                    {`export VENT_REFRESH_TOKEN=<your-token>`}
                  </code>
                  <p className="text-xs mt-1.5">
                    Or run <code className="font-mono">vent login</code> to save it locally.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Key Name</label>
                  <Input
                    placeholder="e.g., Vent CLI Login"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    className="mt-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                    }}
                  />
                </div>
                <Button
                  onClick={handleCreate}
                  className="w-full"
                  disabled={creating}
                >
                  {creating ? "Creating..." : "Create Key"}
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
      <div className="-mx-7 border-b mb-8" />

      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Key className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">No access tokens yet.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create a token to authenticate with the Vent CLI.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {activeKeys.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Active Tokens</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-[80px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeKeys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell className="font-medium">
                          {key.name}
                        </TableCell>
                        <TableCell>
                          <code className="text-sm text-muted-foreground">
                            {key.prefix}...
                          </code>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(key.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevoke(key.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {revokedKeys.length > 0 && (
            <Card className="opacity-60">
              <CardHeader>
                <CardTitle className="text-lg">Revoked Tokens</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Revoked</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {revokedKeys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell>{key.name}</TableCell>
                        <TableCell>
                          <code className="text-sm">{key.prefix}...</code>
                        </TableCell>
                        <TableCell>
                          {new Date(key.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          {key.revoked_at
                            ? new Date(key.revoked_at).toLocaleDateString()
                            : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
