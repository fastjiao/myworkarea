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

    static string bestToken = "";
    static long bestIat = 0;

    static void Main(string[] args)
    {
        string procName = args.Length > 0 ? args[0] : "WorkBuddy";
        Process[] processes = Process.GetProcessesByName(procName);
        Console.Error.WriteLine("Found " + processes.Length + " " + procName + " processes");

        byte[] eyJ = new byte[] { 0x65, 0x79, 0x4A };
        int mbiSize = 48;

        foreach (Process proc in processes)
        {
            IntPtr handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, proc.Id);
            if (handle == IntPtr.Zero) continue;

            long scanned = 0;
            long maxScan = 800L * 1024 * 1024;
            long address = 0;
            byte[] mbiBuf = new byte[mbiSize];

            while (true)
            {
                IntPtr addrPtr = new IntPtr(address);
                int result = VirtualQueryEx(handle, addrPtr, mbiBuf, mbiSize);
                if (result == 0) break;

                long baseAddress = BitConverter.ToInt64(mbiBuf, 0);
                long regionSize = BitConverter.ToInt64(mbiBuf, 24);
                int state = BitConverter.ToInt32(mbiBuf, 32);

                if (state == MEM_COMMIT && scanned < maxScan && regionSize > 0 && regionSize < 100L * 1024 * 1024)
                {
                    int regionSizeInt = (int)regionSize;
                    byte[] buffer = new byte[regionSizeInt];
                    int bytesRead;
                    if (ReadProcessMemory(handle, new IntPtr(baseAddress), buffer, regionSizeInt, out bytesRead) && bytesRead > 100)
                    {
                        scanned += bytesRead;
                        ScanBuffer(buffer, bytesRead, proc.Id);
                    }
                }

                long nextAddr = baseAddress + regionSize;
                if (nextAddr <= address) break;
                address = nextAddr;
            }

            CloseHandle(handle);
        }

        if (bestToken.Length > 0)
        {
            Console.WriteLine(bestToken);
        }
        else
        {
            Console.Error.WriteLine("No WorkBuddy access token found");
        }
    }

    static void ScanBuffer(byte[] buffer, int bytesRead, int pid)
    {
        byte[] eyJ = new byte[] { 0x65, 0x79, 0x4A };
        for (int i = 0; i < bytesRead - 100; i++)
        {
            if (buffer[i] == eyJ[0] && buffer[i + 1] == eyJ[1] && buffer[i + 2] == eyJ[2])
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
                    if (token.Length > 100 && token.Length < 4000 && token.StartsWith("eyJ"))
                    {
                        int dotCount = 0;
                        foreach (char c in token) if (c == '.') dotCount++;
                        if (dotCount >= 2)
                        {
                            TryToken(token, pid);
                        }
                    }
                }
            }
        }
    }

    static void TryToken(string token, int pid)
    {
        try
        {
            string[] parts = token.Split('.');
            if (parts.Length < 2) return;

            string headerJson = DecodeBase64(parts[0]);
            if (!headerJson.Contains("RS256")) return;

            string payloadJson = DecodeBase64(parts[1]);
            if (!payloadJson.Contains("workbuddy.cn")) return;
            if (!payloadJson.Contains("\"Bearer\"")) return;

            int iatIdx = payloadJson.IndexOf("\"iat\":");
            if (iatIdx < 0) return;
            int valStart = iatIdx + 6;
            int valEnd = valStart;
            while (valEnd < payloadJson.Length && (char.IsDigit(payloadJson[valEnd]) || payloadJson[valEnd] == '-'))
                valEnd++;
            long iat = long.Parse(payloadJson.Substring(valStart, valEnd - valStart));

            if (iat > bestIat)
            {
                bestIat = iat;
                bestToken = token;
                Console.Error.WriteLine("  PID " + pid + ": found token iat=" + iat + " len=" + token.Length);
            }
        }
        catch { }
    }

    static string DecodeBase64(string b64)
    {
        string padded = b64;
        while (padded.Length % 4 != 0) padded += "=";
        return Encoding.UTF8.GetString(Convert.FromBase64String(padded));
    }
}
