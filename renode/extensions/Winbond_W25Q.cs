//
// Winbond W25Q (W25Q128JV) on the STM32H7 QUADSPI, for the STM32H7_CORE V1.3.
//
// Renode compiles this file at run time: `include @renode/extensions/Winbond_W25Q.cs`
// before LoadPlatformDescription, then `SPI.Winbond_W25Q @ qspi` in the .repl.
//
// What GenericSpiFlash lacks for MicroPython's mp_spiflash:
//  - 0x35 / 0x31 (Read / Write Status Register-2): the QE bit. GenericSpiFlash
//    decodes 0x35 as Micron's "Enter Quad I/O" and fails.
//  - 0xAB (Release Power-down), harmless.
//  - 0xEB (Fast Read Quad I/O) dummy bytes: STM32H7_QuadSPI sends the mode
//    byte as an alternate byte. Renode 1.16 ignores DCYC, so one byte in all;
//    newer Renode (2026-06, #97751, the renode-latest of Docker/Codespaces)
//    also sends a byte for the dummy cycles, so two. quadIoDummyBytes: -1 (the
//    default) tells them apart by STM32H7_QuadSPI's `dummyBytes` field, which
//    only the newer one has; 1 or 2 forces the count.
//  - trace: true logs every command at Info, for debugging the driver.
//
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Memory;
using Antmicro.Renode.Peripherals.SPI.NORFlash;

namespace Antmicro.Renode.Peripherals.SPI
{
    public class Winbond_W25Q : GenericSpiFlash
    {
        public Winbond_W25Q(MappedMemory underlyingMemory, byte manufacturerId = 0xEF, byte memoryType = 0x40,
            byte capacityCode = 0x18, byte extendedDeviceId = 0x00, int quadIoDummyBytes = -1)
            : base(underlyingMemory, manufacturerId, memoryType, capacityCode: capacityCode,
                   extendedDeviceId: extendedDeviceId, sectorSizeKB: 64)
        {
            if(quadIoDummyBytes < 0)
            {
                var sendsDummyCycles = typeof(STM32H7_QuadSPI).GetField("dummyBytes",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance) != null;
                quadIoDummyBytes = sendsDummyCycles ? 2 : 1;
            }
            this.quadIoDummyBytes = quadIoDummyBytes;
            this.Log(LogLevel.Debug, "0xEB: {0} dummy byte(s) after the address", quadIoDummyBytes);
        }

        protected override int GetDummyBytes(Commands command)
        {
            if(command == Commands.QuadInputOutputFastRead || command == Commands.QuadInputOutputFastRead4byte)
            {
                // mode byte (alternate bytes) + 4 dummy cycles (one byte)
                return quadIoDummyBytes;
            }
            return base.GetDummyBytes(command);
        }

        public bool Trace { get; set; }

        protected override void RecognizeOperation(byte firstByte)
        {
            if(Trace)
            {
                this.Log(LogLevel.Info, "W25Q command 0x{0:X2}, SR1 0x{1:X2}, SR2 0x{2:X2}", firstByte, statusRegister.Read(), statusRegister2);
            }
            switch(firstByte)
            {
            case ReadStatusRegister2:
            case WriteStatusRegister2:
                currentOperation.Operation = firstByte == ReadStatusRegister2
                    ? DecodedOperation.OperationType.ReadRegister
                    : DecodedOperation.OperationType.WriteRegister;
                currentOperation.State = DecodedOperation.OperationState.HandleCommand;
                currentOperation.DummyBytesRemaining = 0;
                currentOperation.Register = StatusRegister2;
                this.Log(LogLevel.Noisy, "Decoded operation: {0}", currentOperation);
                return;
            case ReleasePowerDown:
                // Wake-up from power-down: the model never sleeps.
                currentOperation.Operation = DecodedOperation.OperationType.None;
                currentOperation.State = DecodedOperation.OperationState.HandleCommand;
                currentOperation.DummyBytesRemaining = 0;
                return;
            }
            base.RecognizeOperation(firstByte);
        }

        protected override byte ReadRegister(Register register)
        {
            if((uint)register == StatusRegister2)
            {
                return statusRegister2;
            }
            return base.ReadRegister(register);
        }

        protected override void WriteRegister(Register register, byte data)
        {
            if(Trace)
            {
                this.Log(LogLevel.Info, "W25Q write {0} byte {1}: 0x{2:X2}", register, currentOperation.CommandBytesHandled, data);
            }
            if((uint)register == StatusRegister2)
            {
                if(!WriteEnable)
                {
                    this.Log(LogLevel.Error, "Write Status Register-2 without write enable");
                    return;
                }
                statusRegister2 = data;
                return;
            }
            if(register == Register.Configuration && currentOperation.CommandBytesHandled == 0)
            {
                // the second byte of 0x01 (Write Status Register): Status Register-2
                statusRegister2 = data;
                return;
            }
            base.WriteRegister(register, data);
        }

        // QE (bit 1) set, as on the W25Q128JV-IQ, whose QE is 1 from the factory. mp_spiflash then
        // skips its two-byte Write Status Register, which Renode 1.16's STM32H7_QuadSPI would send
        // byte-swapped (16-bit DR writes are queued MSB first). Non-volatile on the chip too, and
        // GenericSpiFlash.Reset is not virtual in Renode 1.16.
        private byte statusRegister2 = QuadEnable;
        private const byte QuadEnable = 0x02;
        private readonly int quadIoDummyBytes;

        private const byte ReadStatusRegister2 = 0x35;
        private const byte WriteStatusRegister2 = 0x31;
        private const byte ReleasePowerDown = 0xAB;
        private const uint StatusRegister2 = (uint)Register.FirstNonstandardRegister;
    }
}
