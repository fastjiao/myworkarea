using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

class MemoryScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out int lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int VirtualQueryEx(IntPtr hProcess, IntPtr lpAddress, byte[] lpBuffer, int dwLength);

    const int PROCESS_VM_READ = 0x0010;
    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int MEM_COMMIT = 0x1000;

    static void Main(string[] args)
    {
        Console.WriteLine("=== MemoryScan v3 (raw bytes) ===");
        Process[] processes = Process.GetProcessesByName("WorkBuddy");
        Console.WriteLine("Found " + processes.Length + " WorkBuddy processes");

        HashSet<string> foundTokens = new HashSet<string>();
        byte[] eyJ = new byte[] { 0x65, 0x79, 0x4A };

        int mbiSize = 48;

        foreach (Process proc in processes)
        {
            Console.WriteLine("\nScanning PID " + proc.Id + " (memory: " + (proc.WorkingSet64 / 1024 / 1024) + " MB)");

            IntPtr handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, proc.Id);
            if (handle == IntPtr.Zero)
            {
                Console.WriteLine("  Failed to open process: " + Marshal.GetLastWin32Error());
                continue;
            }
            Console.WriteLine("  Handle: " + handle);

            long scanned = 0;
            long maxScan = 800L * 1024 * 1024;
            long address = 0;
            byte[] mbiBuf = new byte[mbiSize];
            int queryCount = 0;
            int readCount = 0;
            int commitCount = 0;

            while (true)
            {
                IntPtr addrPtr = new IntPtr(address);
                int result = VirtualQueryEx(handle, addrPtr, mbiBuf, mbiSize);
                if (result == 0) break;
                queryCount++;

                long baseAddress = BitConverter.ToInt64(mbiBuf, 0);
                long regionSize = BitConverter.ToInt64(mbiBuf, 24);
                int state = BitConverter.ToInt32(mbiBuf, 32);
                int protect = BitConverter.ToInt32(mbiBuf, 36);
                int type = BitConverter.ToInt32(mbiBuf, 40);

                if (queryCount <= 3 || (state == MEM_COMMIT && queryCount <= 15))
                {
                    Console.WriteLine("    Region " + queryCount + ": base=0x" + baseAddress.ToString("X") + " size=" + regionSize + " state=0x" + state.ToString("X") + " prot=0x" + protect.ToString("X") + " type=0x" + type.ToString("X"));
                    if (queryCount <= 3)
                    {
                        StringBuilder hex = new StringBuilder("    Raw: ");
                        for (int bi = 0; bi < mbiSize; bi++) hex.Append(mbiBuf[bi].ToString("X2") + " ");
                        Console.WriteLine(hex.ToString());
                    }
                }

                if (state == MEM_COMMIT && scanned < maxScan)
                {
                    commitCount++;
                    if (regionSize > 0 && regionSize < 100L * 1024 * 1024)
                    {
                        int regionSizeInt = (int)regionSize;
                        byte[] buffer = new byte[regionSizeInt];
                        int bytesRead;
                        if (ReadProcessMemory(handle, new IntPtr(baseAddress), buffer, regionSizeInt, out bytesRead) && bytesRead > 100)
                        {
                            scanned += bytesRead;
                            readCount++;

                            for (int i = 0; i < bytesRead - 100; i++)
                            {
                                if (buffer[i] == eyJ[0] && buffer[i+1] == eyJ[1] && buffer[i+2] == eyJ[2])
                                {
                                    int end = -1;
                                    for (int j = i + 3; j < Math.Min(i + 4000, bytesRead); j++)
                                    {
                                        byte b = buffer[j];
                                        if (b < 0x20 || b > 0x7E)
                                        {
                                            if (j - i > 100) { end = j; break; }
                                            else { end = -1; break; }
                                        }
                                    }

                                    if (end > 0 && end - i > 100)
                                    {
                                        string token = Encoding.UTF8.GetString(buffer, i, end - i);

                                        if (token.Length > 100 && token.Length < 4000)
                                        {
                                            int dotCount = 0;
                                            foreach (char c in token) if (c == '.') dotCount++;
                                            if (dotCount >= 2 && token.StartsWith("eyJ"))
                                            {
                                                if (!foundTokens.Contains(token))
                                                {
                                                    foundTokens.Add(token);
                                                    Console.WriteLine("\n=== JWT Token in PID " + proc.Id + " offset " + i + " ===");
                                                    Console.WriteLine("Length: " + token.Length);
                                                    Console.WriteLine("Token: " + token.Substring(0, Math.Min(300, token.Length)));

                                                    try
                                                    {
                                                        string[] parts = token.Split('.');
                                                        string payload = parts[1];
                                                        while (payload.Length % 4 != 0) payload += "=";
                                                        string decoded = Encoding.UTF8.GetString(Convert.FromBase64String(payload));
                                                        Console.WriteLine("Payload: " + decoded);
                                                    }
                                                    catch {}

                                                    File.WriteAllText(@"D:\tmp\wb_token_" + foundTokens.Count + ".txt", token);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                long nextAddr = baseAddress + regionSize;
                if (nextAddr <= address) break;
                address = nextAddr;
            }

            Console.WriteLine("  Queries: " + queryCount + ", Commits: " + commitCount + ", Reads: " + readCount + ", Scanned: " + (scanned / 1024 / 1024) + " MB");
            CloseHandle(handle);
        }

        Console.WriteLine("\nTotal unique tokens found: " + foundTokens.Count);
    }
}
